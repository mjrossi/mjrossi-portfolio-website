# CLAUDE.md

Guidance for coding agents (Claude Code, Codex) working in this repository. `AGENTS.md` is a symlink to this file.

Six companion docs carry the detail this file only summarises — read the relevant one before editing in its area:

- [docs/FILE-MAP.md](docs/FILE-MAP.md) — every file that carries a decision, and the bug each rule prevents.
- [docs/GALLEY.md](docs/GALLEY.md) — the inline editorial review system, in full.
- [docs/PREVIEW-LINKS.md](docs/PREVIEW-LINKS.md) — how a draft is shown to someone, and how that is taken back.
- [docs/NEWSLETTER.md](docs/NEWSLETTER.md) — env-var sourcing and the operator-side Buttondown design.
- [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md) — mise vs wrangler, local dev, and reading a smoke failure.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — architecture, deployment, CI, and the Cloudflare account inventory.

## Stack

Astro 7 with the `@astrojs/cloudflare` adapter. Plain CSS, **two** scoped pieces of client JS: the newsletter form, on `/blog` and at the foot of every *published* post (see "Newsletter"), and the galley review client, which loads only on a signed review link (see "The galley"). Neither appears on a non-blog page, and neither reaches a draft. `output: 'server'` — every route runs in the Cloudflare worker by default; only `/404` opts back into static via `export const prerender = true`. `/blog/rss.xml` is intentionally on-demand (not prerendered) so scheduled posts can enter the feed at request time — see "Blog". `src/middleware.ts` sets `Cache-Control: public, max-age=3600` on every HTML response so the edge cache absorbs traffic while the dynamic edition line refreshes hourly. Build output: `dist/client/` (assets, served via the `ASSETS` binding in `wrangler.jsonc`) plus the server bundle in `dist/server/` that Wrangler deploys as the worker. Node 22 (pinned in `mise.toml`).

**Server endpoint convention:** anything that doesn't render a page (redirects, JSON APIs) lives under `src/pages/api/*`. All endpoints share `src/lib/server.ts` for security headers, env access, JSON parsing, and error responses.

## File map

One line per file. **The reasoning — why each rule exists and the bug it prevents — is in [docs/FILE-MAP.md](docs/FILE-MAP.md). Read that before editing anything under `src/lib/`, `src/components/`, `scripts/`, or `migrations/`;** nearly every entry there records a failure that has already happened once.

### Layouts and components

- `src/layouts/Base.astro` — shared shell: masthead on every page, edition line built at request time, `ogImage` / `ogImageAlt` props.
- `src/layouts/BlogPost.astro` — post chrome. Gates the subscribe card, previous/next **and** the galley on publication.
- `src/layouts/Desk.astro` — the Desk's chrome and **all** of its CSS (`is:global`), imported only by `/admin` so it never reaches a public bundle.
- `src/components/ContactLinks.astro` — inline-SVG icon row; rendered twice per page (nav + footer), both asserted by smoke.
- `src/components/BlogPostEntry.astro` — shared post card for the index and tag pages. Deliberately carries **no** chip row.
- `src/components/Figure.astro` — `<figure>` around `astro:assets` `<Image>` with an optional caption; imported by `.mdx` posts.
- `src/components/diagrams/*.astro` — per-post hand-authored inline SVG. One post each, not site chrome; styling via `.dg-*` in `global.css`.
- `src/components/Subscribe.astro` — the email signup: `line` (blog index) and `card` (foot of every *published* post). **JS carve-out #1.**
- `src/components/PostTopics.astro` — up to two topics in the meta line (`TOPIC_LIMIT`), in frontmatter order.
- `src/components/PostTags.astro` — the chip list, rendered **once**, in the footer under "Filed under".
- `src/components/PostNav.astro` — previous/next by date. Renders nothing for a missing neighbour, and nothing at all on a draft.
- `src/components/PageHeader.astro` — shared interior-page header (`<h1>` + description + `.page-meta` slot).
- `src/components/GalleyMargin.astro` — review chrome. Owns its styles in an **`is:inline`** block; both directions matter (see [docs/GALLEY.md](docs/GALLEY.md)).

### Routes

- `src/pages/*.astro` — one file per route. Public: `/`, `/work`, `/projects`, `/education`, `/urban-mobility`, `/blog`, `/blog/tags`, `/privacy`, `/404`. Plus Access-gated `/admin`.
- `src/pages/blog/index.astro`, `[...slug].astro`, `tag/[tag].astro`, `rss.xml.ts` — list, post, per-tag, RSS. RSS is **on-demand**, not prerendered.
- `src/pages/admin/index.astro`, `src/pages/admin/[slug].astro` — the Desk. Zero client JS, which is what keeps it clear of the site-wide CSP.
- `src/pages/api/contact.ts` — `GET` → 302 to `mailto:`, so the address never appears in static HTML.
- `src/pages/api/subscribe.ts` — newsletter POST: verifies Turnstile, forwards to Buttondown, treats already-subscribed as success.
- `src/pages/api/galley.ts` — `GET`/`POST` galley notes. Authorisation comes entirely from `Astro.locals`; owns its own write-quota SQL.
- `src/middleware.ts` — security headers on every response, CSP + `Cache-Control` on HTML, the `/admin` Access gate, and both preview unlocks.

### Content and rendering

- `src/content.config.ts` — Zod schema for post frontmatter; single source of truth for required fields and tag validation.
- `src/content/blog/<slug>.mdx` — one file per post (or `<slug>/index.mdx` when colocating images).
- `src/lib/blog.ts` — the single boundary between content source and rendering. `getPublishedPosts` enforces scheduled publishing.
- `src/lib/archive.js` — the archive as a *sequence*: `FIXTURE_SLUG`, `realPosts`, `adjacentIn`, `latestIn`. **`FIXTURE_SLUG` is declared here, once.**
- `src/lib/schedule.js` — `isPublished`, plus `publicationTime` / `clampToPublication` (how a preview link's expiry is capped).
- `src/lib/pubdate.js` — `coercePubDate`: the frontmatter-date rule, shared by the build and the minting scripts. Rejects one shape only.
- `src/lib/tags.js` — `tagLabel` plus `RETIRED` / `retiredTarget`, the map from a consolidated tag to where it goes now.
- `src/lib/edition.js` — `issue(now?)`. **One derivation, one launch epoch, called once per render in `Base.astro`.** Nothing in page chrome may derive an issue from content.
- `src/lib/identity.js` — `TAGLINE`, `SET_IN`, `BUILT_WITH`, `SITE_DESCRIPTION`: the sentences the site says about itself, in **three** engines.
- `src/lib/now.js` — `NOW_UPDATED` and `nowUpdatedLabel()`, the dateline under the home page's Now heading.
- `src/lib/readingTime.js` — word-count read time. Plain JS so the OG generator can import it under bare Node.
- `src/lib/post-source.ts` — `SOURCE_BY_SLUG` and `revisionOf(slug)`. Two definitions of this hash would refuse every galley write.
- `src/lib/remark-source-anchors.js` — stamps `data-src` on every commentable block. **Why `@astrojs/markdown-remark` is a direct dependency.**
- `src/styles/global.css` — all styles, imported once via `Base.astro`. CSS custom properties.

### Security, preview, and the Desk

- `src/lib/csp.js`, `src/lib/security-headers.js` — the canonical header sets, imported by middleware **and** `scripts/gen-headers.mjs` so they can't drift.
- `dist/client/_headers` — **generated** during `npm run build`, not checked in. Applies only to ASSETS-binding responses.
- `src/lib/preview.js` — `isPreviewHost`, `signPreviewToken` / `verifyPreviewGrant`, `newLinkId`, `WORKER_NAME`. Deliberately **DB-free**.
- `src/lib/preview-links.js` — `isLinkActive(DB, id, now?)`: the allowlist lookup that makes a link revocable **and** extendable.
- `src/lib/link-state.js` — `live` / `expired` / `revoked` / `spent` and the extend headroom, so the CLI and the Desk cannot disagree.
- `src/lib/access.js` — Cloudflare Access JWT verification. **`aud` is the load-bearing claim** — Access signs per team, not per app.
- `src/lib/admin-path.js` — `isAdminPath`, shared by middleware and the sitemap filter, because three things must agree on the answer.
- `src/lib/desk.js` — `deskIndex` (a **union**, not a filter) and `countdown` (calendar days in UTC, not elapsed time).
- `src/lib/server.ts` — shared `/api/*` plumbing. `tryGetEnv()` is the fail-closed read; `refuse` **drains** the request body rather than cancelling it.
- `src/env.d.ts` — Cloudflare `Env`, `ImportMetaEnv`, `App.Locals`, `__BUILD_TIME__`. **`undefined` must always mean denied.**
- `wrangler.jsonc` — Worker config, `ASSETS` binding, the Access `vars`, and `SESSION` (which the adapter injects whether or not it is used).
- `astro.config.mjs` — adapter, MDX, sitemap (**filtered through `isAdminPath`**), fonts, and the `__BUILD_TIME__` define.

### The galley and its data

- `src/lib/galley.js` — note validation + `sha256Hex`, shared by the write endpoint and the pull script.
- `public/scripts/galley-quote.js` — **both directions** of the quote anchor. DOM-free, so `node --test` reaches it via `src/lib/galley-quote.test.js`.
- `src/lib/galley-relocate.js` — `unmark` / `fold` / `createLocator`, plus the emitters for reviewer text.
- `src/lib/galley-render.js` — the pulled review file itself, and `reviewModel`, which the Desk renders as HTML.
- `src/lib/galley-manifest.js` — `noteIdsInMarkdown`: **what `just galley-close` actually retires.** Reads meta lines only.
- `public/scripts/galley.js` — the review client: selection → note, notes → markers. **JS carve-out #2**, and the tighter of the two.
- `public/scripts/newsletter.js` — the Turnstile loader + submit handler for `Subscribe.astro`.
- `src/lib/links-store.js` / `src/lib/notes-store.js` — the only owners of `preview_links` / `galley_notes` SQL, against a duck-typed store.
- `src/lib/sql-literal.js` — `renderSql` / `sqlLiteral`: **the escaping boundary** for every statement run from the CLI, and the whole of it.
- `migrations/0001_initial.sql` — the original schema. **Frozen.** `0002_preview_link_ceiling.sql` — `max_exp`. `0003_galley_note_closure.sql` — `closed_at`, drops `status`.

### Scripts

- `scripts/cli.mjs` — the shared operator prologue: `die`, `resolveDatabase`, `requirePost`. **Argv parsing deliberately stays per-script.**
- `scripts/database-target.mjs` — `chooseDatabase`. Every D1 script requires an explicit `--remote` or `--local`; there is **no default**.
- `scripts/d1.mjs` / `scripts/d1-store.mjs` — the wrangler transport, and the D1-compatible façade over it.
- `scripts/links-db.mjs`, `scripts/notes-db.mjs` — thin binders turning `{ local }` into a store; the local-only guards live here.
- `scripts/content.mjs` — `resolvePostSource` and `readPubDate` (js-yaml **then** `coercePubDate`, same two steps as the build).
- `scripts/dev-vars.mjs` — the one `.dev.vars` parser, shared by `preview-link.mjs` and `smoke.mjs` so signing and verifying agree.
- `scripts/preview-link.mjs` — mints a link. **Records the row before printing the URL.** Sets both expiries; clamps the row to `pubDate`.
- `scripts/preview-extend.mjs` — moves a live link's expiry in place. **The URL does not change.** `--all` for a slipped `pubDate`.
- `scripts/preview-roster.mjs` — lists and revokes. **The only inventory of issued links there is.** `--all` lists across every post.
- `scripts/galley-pull.mjs` — pulls notes into `docs/galley/<slug>.md`. Open notes only unless `--all`; prints every note id.
- `scripts/galley-close.mjs` — reads that file back and closes the ids in it. Run **after** the merge. `scripts/galley-reopen.mjs` is the undo.
- `scripts/galley-preview.mjs` — `just galley-preview`: the margin against fixtures, no build/worker/DB. **Run `--stale` too.**
- `scripts/gen-headers.mjs` — writes `dist/client/_headers` during the build.
- `scripts/make-og.mjs`, `scripts/make-noise.mjs` — one-off regenerators. **The site card states identity only — never a fact about the present.**
- `scripts/make-post-og.mjs` — runs on **every** build, published posts only. Gates on `__BUILD_TIME__`, not the request clock.
- `scripts/smoke.mjs` — the run sequence and nothing else; the ordering of its phases is the part to read before changing anything.
- `scripts/smoke/*.mjs` — the assertions: `config`, `check`, `static`, `wrangler`, `fixtures`, `runtime`, `live-site`, `live-preview`, `access`, `live-desk`.
- `public/.assetsignore` — keeps worker artifacts out of the static asset binding.
- `.github/workflows/` — `build.yml` (build + smoke), `lighthouse.yml` (production only, pass/fail gate).

### Direct dependencies that only resolve by accident otherwise

`js-yaml`, `sharp`, `@astrojs/markdown-remark` and `typescript` are declared directly because this repo imports them itself — the first three resolved only via astro's hoisting, and `typescript` exists for `mdx-analyzer` in the editor, invisibly to CI. Pins and full rationale in [docs/FILE-MAP.md](docs/FILE-MAP.md).

## Design system

CSS custom properties at `:root` in `src/styles/global.css` (warm-amber Broadsheet palette, light cream background):

- `--bg`, `--bg2` — cream page background and slightly darker secondary surface (oklch).
- `--border` — hairline rules and dividers.
- `--text`, `--muted` — primary and secondary text.
- `--accent` `#8f5520`, `--accent-hover` `#7a4a1a` — link color (AA against `--bg`).
- `--accent-surname` `#c97d3e` — the "Rossi" highlight in the masthead name.
- `--accent-band`, `--accent-band-border`, `--accent-rule`, `--accent-tagline` — masthead band, double-rule borders, hairlines, and the italic tagline color.
- `--font` (Source Serif 4) — body. `--font-serif` (Fraunces) — display. `--font-ui` (Inter) — nav and meta. All loaded via Astro's `Font` integration (`astro.config.mjs`) and exposed as CSS variables. `--font-mono` is a **system stack with no webfont** — it is used at 0.82em inside running prose, which is not a size worth a network request.
- `--max: 1100px`, `--pad: clamp(1.25rem, 4vw, 2.5rem)` — page width and gutter.

Section labels: `font-variant-caps: all-small-caps` with letter-spacing. Experience and education entries use `.entry` / `.entry-header` / `.entry-meta` / `.company` / `.role` / `.date`. Interior pages use `.page` / `.page-header` / `.page-meta`.

Smoke test asserts a handful of tokens on the built CSS bundle (`--max: 1100px`, `--accent: #8f5520`, no inline SVG data URIs) and then exercises every on-demand route through `wrangler dev`. Update `scripts/smoke/static.mjs` (tokens, assets) or `scripts/smoke/live-site.mjs` (chrome) alongside any change to what they pin.

## Content

Static page copy lives in the page files under `src/pages/`. Pages in order: `/` (About + Now), `/work`, `/education`, `/urban-mobility`, `/blog`.

## Blog

The blog is a **periodical within the site**. Site identity is "Matthew Rossi" (the author, masthead of every page); blog identity is "The Urbanist Lexicon" (the periodical, set on `/blog` and `/blog/rss.xml` and in the RSS-to-email mailings). Keep them distinct: the site masthead is author-led, the blog header and emails are periodical-led with the author dropping to a byline.

Driven by Astro Content Collections + MDX. Posts are markdown, published via `git push` — no database, no runtime.

- `src/content.config.ts` — Zod schema for post frontmatter (single source of truth)
- `src/content/blog/<slug>.mdx` — one file per post (or `<slug>/index.mdx` when colocating images)
- `src/lib/blog.ts` — `getPublishedPosts`, `getAllTags`, `getPostsByTag` — the single boundary between content source and rendering (a future D1 migration swaps only this module)
- `src/layouts/BlogPost.astro` — post chrome (title, byline, tags, optional cover, back link)
- `src/pages/blog/index.astro` — list of posts
- `src/pages/blog/[...slug].astro` — individual posts (slug = filename)
- `src/pages/blog/tags.astro` — the topic index at `/blog/tags`: every topic with its post count, most-written first. Linked from a "Topics" pill beside the RSS pill on the blog index. Chips have always linked to `/blog/tag/<slug>` and nothing listed those pages
- `src/pages/blog/tag/[tag].astro` — per-tag listings at `/blog/tag/<tag>`, with sibling topics and an "All topics" link, and a **301 for any slug the taxonomy consolidation retired** (checked before the membership test — see `src/lib/tags.js`)
- `src/pages/blog/rss.xml.ts` — RSS feed at `/blog/rss.xml`. On-demand (not prerendered) so scheduled posts enter the feed once their `pubDate` passes, with no rebuild; sets its own `Cache-Control: public, max-age=3600` since middleware only adds cache headers to HTML responses.
- `src/components/Figure.astro` — opt-in component for inline images with a visible caption. Import it at the top of an `.mdx` post (`import Figure from '../../../components/Figure.astro';`) plus an ESM image import for each photo, then use `<Figure src={...} alt="..." caption="..." />`. Plain markdown `![alt](src)` still works for images that don't need a caption.

### Diagrams in posts

When a post needs a diagram rather than a photograph, it goes in `src/components/diagrams/` as an `.astro` component emitting **hand-authored inline SVG**, imported by that one post. Three exist today, all in `the-data-was-the-hard-part.mdx`: `RegionGraphNYC.astro`, `RegionGraphChicago.astro`, and `PolygonHoleArea.astro`.

Inline SVG rather than a rendered image, for reasons that are unlikely to change:

- **Mermaid can't run here.** The Atlas repo draws these same shapes in mermaid, but the site ships no client JS outside the newsletter carve-out and `script-src 'self'` would block it anyway. Pre-rendering mermaid to a file means a Puppeteer/Chromium dev dependency and a visual style that fights the Broadsheet palette.
- **It inherits the design system.** The SVG uses `.dg-*` classes defined in `global.css`, so nodes, rules, and type resolve to `--bg2`, `--border`, `--accent`, `--accent-rule`, `--muted`, `--font-ui` — the same tokens as the rest of the page, with nothing to re-sync if the palette moves.
- Sharp at any zoom, no image weight, and the graph is readable by a screen reader via `role="img"` + `<title>` + `<desc>`.

Conventions worth keeping:

- **Transcribe from shipped data, not from prose or design docs.** The two region graphs were built against `api/seed/*.toml` in the Atlas repo, and the header comment in each component records the exact `parents = [...]` lines it encodes. Design docs drift — `docs/region-graph.md` renders DuPage as a stand-in for all five Chicago collar counties, which is a fine simplification in a doc but would misstate the seed if copied literally. Anything drawn from a doc instead of the data will eventually contradict the product; where a diagram does simplify, say so in the header comment and say why.
- **A diagram of an algorithm cites the function, not the seed.** `PolygonHoleArea.astro` is the one diagram with no TOML behind it — it illustrates `polygonArea` / `nestingDepth` in `api/internal/etl/ca/geom.go`, and its header comment records the depth-parity rule it encodes. Where possible make the drawing enforce the claim rather than restate it: that shape is a single `<path>` with `fill-rule="evenodd"`, so the browser fills it by the same rule the ETL measures it by and the picture can't silently drift from the prose.
- **Don't draw an edge the code doesn't walk.** `rollup_states` is browse-only and is deliberately absent from both region graphs — drawing it would assert exactly the relationship the diagram exists to rule out.
- **Marker and `aria-labelledby` IDs must be unique per page.** Three diagrams render in the same post, so IDs are prefixed (`dg-nyc-*`, `dg-chi-*`, `dg-area-*`).
- **Wide diagrams scroll, they don't shrink.** `.post-diagram` is an `overflow-x: auto` box and the SVG carries `min-width: 460px`, so on a narrow screen the diagram scrolls inside its own container while the page body never scrolls sideways. Below that floor the labels stop being legible, so scrolling is the better trade. Verify with a real narrow column — headless Chrome clamps its layout viewport to ~500px, so a 390px `--window-size` screenshot shows a cropped 500px layout and looks like a bug that isn't there.

### House conventions for a post

Three rules that came out of the August 2026 design review. All three are about the post as written, not about the CSS, so nothing enforces them but this section.

**Open on a standfirst.** One paragraph, one or two sentences, saying what the post is — before the first `##`. It orients the reader before the sectioning starts, and it is what the drop cap lands on. The cap selector is `.post-body > p:first-of-type`, so a post that opens straight into a heading gets its cap on whatever paragraph comes first; that used to be `:first-child`, which meant a post opening on an `h2` (or on an MDX `import`) got no cap at all. A post that opens on a **figure** suppresses the cap entirely — `:first-of-type` would otherwise put one halfway down the page, which reads as a rendering fault.

**Order the tags most-specific-first.** The **first two** tags are the post's topics, and they are the ones that render in the meta line, on the post and on the index entry (`PostTopics.astro`). The rest appear only in the post's footer under "Filed under". Where a post belongs to a series, lead with the series tag — a shared first topic is what makes the series legible across entries. Nothing validates the ordering, so getting it wrong is silent and looks like an editorial judgement.

**Stay inside the working vocabulary.** Ten tags: `advocacy`, `artificial-intelligence`, `career`, `cycling`, `governance`, `infrastructure`, `personal`, `software-engineering`, `transit`, `urbanist-atlas` (plus `smoke-fixture`, which is the fixture post's alone). Consolidated from thirteen, of which `urban-mobility` was on every post and therefore discriminated nothing. `src/lib/tags.test.js` pins this set against real frontmatter — **a new tag fails that test**, which is deliberate: adding one should be a decision, not something that accretes a post at a time. Add it to the expected list in the same commit, and if you are replacing a tag rather than adding one, add the old slug to `RETIRED` in `src/lib/tags.js` so its URL 301s instead of 404ing.

### Frontmatter

```yaml
---
title: "Post title"
description: "One-line summary — used on list, OG, RSS"
pubDate: 2026-05-10        # a FUTURE date schedules the post — see below
# pubDate: 2026-05-10T14:00:00      # a time works too, and is UTC
# pubDate: 2026-05-10T09:00:00-04:00 # or name the offset
updatedDate: 2026-05-12   # optional
tags: ["urban-mobility", "transit"]  # optional, must be kebab-case
cover:                     # optional
  src: "./cover.jpg"
  alt: "Alt text"
  caption: "Optional visible caption"
---
```

Invalid frontmatter fails the build. Committing a post with a past or present `pubDate` publishes it immediately.

**`pubDate` can carry a time of day, and the quoting rule is not decoration.** A bare `YYYY-MM-DD` is midnight UTC. Add a time when the hour matters — which it now does beyond scheduling, because a preview link's expiry is capped at publication. Astro parses frontmatter with `js-yaml`, which resolves an **unquoted** timestamp to a `Date` and reads one with no offset as **UTC**:

| frontmatter | instant |
|---|---|
| `pubDate: 2026-05-10` | `2026-05-10T00:00:00Z` |
| `pubDate: 2026-05-10T14:00:00` | `2026-05-10T14:00:00Z` |
| `pubDate: 2026-05-10T09:00:00-04:00` | `2026-05-10T13:00:00Z` |
| `pubDate: "2026-05-10T14:00:00"` | **build error** |

**Quote a timestamp and it stops being a YAML timestamp.** js-yaml hands back a string, `new Date()` parses a date-*time* with no offset as **local**, and the same literal means `18:00Z` on a machine in New York and `14:00Z` in the worker — with nothing red anywhere. `src/lib/pubdate.js` rejects exactly that shape at build time and says how to fix it; every other form passes through. Date-*only* is UTC quoted or not, so `"2026-05-10"` is fine. The behaviour this all rests on is pinned in `src/lib/pubdate.test.js`, because it belongs to a library nothing here calls directly — a js-yaml major that changed it would otherwise move every timed post by hours with every date still looking correct in the file.

**Scheduled publishing.** A post with a **future `pubDate`** can be merged to `main` and stays hidden in production — from the blog index, tag pages, its direct URL (which 404s), and the RSS feed — until that date passes, at which point it appears everywhere automatically with no rebuild or redeploy. This works because every one of those surfaces flows through `getPublishedPosts` (which filters future posts in production), and both the pages and the RSS feed are on-demand, so they re-evaluate "now" on each request. `pubDate` is a date, so the boundary is midnight UTC on that day. Future posts stay **visible in local `npm run dev`** for preview; note that `npm run preview` builds in production mode and therefore hides them exactly like production. There is no separate draft flag — a future date *is* the scheduling mechanism; use a git branch only if a post isn't ready to ship at all.

Two caveats worth knowing before scheduling a timed launch:

- **Expect up to an hour of lag, not instant publication.** `/blog`, tag pages, and the RSS feed all carry `Cache-Control: public, max-age=3600`, so a cached viewer can keep seeing the pre-publication version for up to an hour past the `pubDate`, and Buttondown won't see the new item in the feed until its poll hits a fresh response. **A time of day expresses intent, not precision** — naming `14:00:00Z` does not make the post appear at 14:00 for everyone, it makes the *server-side* boundary 14:00 and leaves the edge cache in front of it. Don't schedule a post expecting it to be visible at an exact minute. (The post's own URL is safe from stale caching in the other direction — the 404 it serves while hidden carries no `Cache-Control`, so it isn't edge-cached.)
- **Images from a scheduled post are public before the post is.** `astro:assets` processes cover and inline images at build time, so they land in `dist/client/_astro/<name>.<hash>.ext` and are fetchable as soon as the build deploys. They're unlinked and hash-named, so effectively unguessable — but don't schedule a post whose cover image is itself the announcement.

The filter predicate lives in `src/lib/schedule.js` (plain JS, no `astro:content` import) and is unit-tested in `src/lib/schedule.test.js` via `npm test`. `smoke.mjs` separately asserts that `getPublishedPosts` still *calls* it — the unit tests alone would stay green if the filter were dropped from the call site.

#### Previewing a scheduled post

Two unlocks, both resolved in `src/middleware.ts` and both **fail-closed**. **Full mechanism in [docs/PREVIEW-LINKS.md](docs/PREVIEW-LINKS.md)** — read it before touching `src/lib/preview.js`, `src/lib/preview-links.js`, or any `scripts/preview-*.mjs`.

1. **`*.workers.dev` branch hosts** reveal *every* scheduled post, automatically and with no token. The Worker's own production alias is excluded and `wrangler.jsonc` sets `"workers_dev": false`; `preview_urls` must stay pinned to `true`. `localhost` is deliberately *not* a preview host, which is what keeps `npm run preview` and smoke on the production code path.
2. **Signed expiring links** reveal **one** post, on any host:

```sh
npm run preview-link -- my-draft --remote              # 48h, mjrossi.com
just preview-roster my-draft --remote                  # what is outstanding
just preview-extend my-draft <id> --hours 96 --remote  # more time, same URL
just preview-revoke my-draft <id> --remote             # take it back — reading included
```

**A signed link is scoped to the post's own URL and nothing else.** It does not add the draft to `/blog`, tag pages, or `/blog/rss.xml`. That is load-bearing rather than tidy: the feed is what triggers Buttondown's email, an irreversible send to real subscribers. `getPublishedPosts` therefore takes only a boolean `showScheduled`, and the per-slug signal (`Astro.locals.previewSlug`) is read solely by `src/pages/blog/[...slug].astro`. Smoke greps for exactly that **and** proves it live against a permanently future-dated fixture post.

The token is `<slug>.<exp>.<linkId>.<hmac>`, or `<slug>.<exp>.<reviewer>.<linkId>.<hmac>` when it also grants galley notes. Every field except the signature is inside the signed payload, so a link cannot be edited to open another draft, have a reviewer spliced in, or be repointed at a different allowlist row.

**A signature is necessary but not sufficient.** Every link also gets a row in `preview_links`, which middleware requires un-revoked and unexpired. The token's signed `exp` is a **ceiling** — 30 days out, immutable, because moving it would mean a new URL. The expiry actually enforced is the *row's* `exp`, which `just preview-extend` moves in place and which minting clamps to the post's `pubDate`. **`just preview-roster` is the only inventory of issued links there is**; a link missing from it cannot be revoked, only waited out.

**Everything fails closed.** No signing key, no `DB` binding, a D1 error, a missing row, a revoked row, an expired row, or an `exp` that is not a finite number all resolve to no grant. There is deliberately no branch in this feature where a failure widens access.

Any response with either unlock active gets `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`, **overriding** whatever was set. This is the one place middleware overrides rather than setting-if-absent — a cached or indexed draft is precisely the failure being avoided.

Wherever a scheduled post is visible, it carries a `Scheduled` badge (`.post-scheduled`). The badge keys off `isPublished`, not the preview flag, so it can only ever appear on a post that isn't live.

### The galley

Inline editorial review. Editors open a signed link, read the real rendered post, select a passage, and leave a note; notes come back anchored and structured, so applying them to the MDX is mechanical rather than interpretive.

```sh
just preview-link my-draft --remote --reviewer jd   # one link per editor, mint with initials
just galley my-draft --remote                       # → docs/galley/my-draft.md
just galley-close my-draft --remote                 # after the revision merges — ends the round
```

**Full reasoning is in [docs/GALLEY.md](docs/GALLEY.md)** — the pulled file's structure, the staleness gates, the marker rules, concurrent reviewers, the local loop, and the authoring workflow. Read it before touching `public/scripts/galley*.js`, `src/lib/galley-*.js`, `src/pages/api/galley.ts`, `GalleyMargin.astro`, or `scripts/galley-*.mjs`. What follows is only what a change anywhere else in the repo can break.

**Git holds the post. D1 holds the conversation about the post.** Do not migrate posts into the database — `Figure`/`diagrams/*`, `astro:assets` and Zod frontmatter validation all run at build time, and all three would have to be rebuilt at runtime.

**The galley does not hand out access.** Links are minted, listed, extended and revoked with `just preview-link` / `preview-roster` / `preview-extend` / `preview-revoke` — one vocabulary for who may see a draft, whether or not they may comment. That is why there is no `galley-link`.

**Publishing closes the galley.** `BlogPost.astro` stops rendering the margin and `/api/galley` refuses both methods with `post_published` once `pubDate` has passed. Enforced in both places, because the layout decides whether the margin is *drawn* and the endpoint decides whether a note can be *written*.

**Scope is unchanged from a read-only link.** A review link grants *writing*, not *reach*: still one post, still not `/blog`, still not tag pages, and above all still not `/blog/rss.xml` — the feed is what triggers Buttondown's irreversible send. `previewReviewer` must never reach `src/lib/blog.ts` or the RSS route; smoke greps for exactly that and separately proves it live.

**The second JS carve-out is tighter than the first.** `galley.js` loads only when `previewReviewer` is set *and* `previewSlug` matches the post being rendered — so it can only ever appear on a response middleware has already forced to `no-store` + `noindex`. Don't loosen that gate in `BlogPost.astro`. `galley-quote.js` inherits it by being imported from `galley.js` rather than tagged in the component; keep it that way.

**The CSS does not inherit that gate for free.** Astro hoists a processed `<style>` into the route's stylesheet from the *static module graph*, not from the runtime condition that renders the component — so a plain `<style>` in `GalleyMargin.astro` ships every `.galley-*` rule on every published post, invisibly. The block is `is:inline` for that reason, and because scoped styles would never match elements `galley.js` creates at runtime. Smoke asserts both directions.

**Never add a quote fallback for stale notes.** It looks like a free improvement and it silently destroys the property that licenses quote matching at all: on unchanged source a single occurrence is provably the reviewer's, but on changed source it is merely the only *remaining* one. Relocating a stale note is the pull side's job, where `galley-relocate.js` has the prefix/suffix to do it honestly.

**`data-src` ships on every block of every published post**, not just drafts under review — `remark-source-anchors` runs at build time, where there is no request to condition on. Worth knowing before treating one in production HTML as a bug.

**The token rides in a URL, so `Referrer-Policy` is load-bearing.** Relaxing it to `unsafe-url` would hand every outstanding review link to every site a draft links to.

Setup, once: `wrangler d1 migrations apply mjrossi-galley --remote`. If `--remote` D1 commands fail with `[code: 7403]`, that is `CLOUDFLARE_API_TOKEN` lacking **D1:Edit**, not a wrangler or account problem.

### The Desk

`/admin` — a read-only operator page answering the two questions a review round raises when you are **not at the laptop**: *what is outstanding?* and *what did they say?* Everything else about the galley stays a CLI.

- `/admin` — every scheduled draft, plus any post still carrying open notes or live links, soonest publication first. Then a "links with no post" section.
- `/admin/<slug>` — one post: its full link roster with state, and its galley notes grouped by passage exactly as `just galley` would write them, closed rounds behind a disclosure.

**It reads. It does not write.** Minting, extending, revoking, pulling and closing are all still `just` commands. That is not a stopgap: `galley-pull` writes `docs/galley/<slug>.md` into the repo and `galley-close` reads that same file back as its manifest, so both are git operations rather than database ones, and a button that skipped the file would break the one property that makes a close honest. Mint / extend / revoke *could* move here — they are pure D1 plus the signing key — but they would need a CSP carve-out (`form-action` is `'none'` site-wide), and read-only is what makes this page cost nothing.

**`/admin` is the first deliberately unscoped surface in this repo, and that is the thing to hold on to.** Every other read path names one post by construction — a signed link grants one slug, `/api/galley` has no cross-post mode, `preview-roster --all` is justified only by running on a CLI already authenticated as you. The Desk lists every draft, every reviewer label and every note at once. What a leak would cost: draft titles, prose, reviewer initials and note text. What it would *not* cost: the ability to open a draft or mint a link — a link id is not a token, the HMAC is, and minting is not here at all.

#### The gate

Cloudflare Access on `mjrossi.com/admin*`, **and** the worker verifies the JWT itself (`src/lib/access.js`). The second check is not belt-and-braces theatre; it is the same posture as `workers_dev: false` paired with `isPreviewHost` excluding the production alias. One route that misses the Access app and the edge gate is simply not in the path.

**`aud` is the load-bearing claim.** Access signs per **team**, not per application, so a token from *any* app on the account verifies its signature here — including this account's other app, the one covering preview-URL hostnames, whose policy is the looser of the two by design. Without comparing the audience against the Desk app's own tag, that token opens the Desk: signature-valid and entirely wrong, the same shape as a cross-slug preview token. Smoke asserts it live, and deleting the comparison fails that one check and nothing else.

Everything fails closed — no token, malformed, unknown key, wrong audience, wrong issuer, expired, **missing config**, or a JWKS that will not fetch. A failure returns **404, not 403**: `/admin` existing at all is worth not confirming, and it matches what a scheduled post does without a token.

Setup, once:

1. Zero Trust → Access → Applications → self-hosted, path `mjrossi.com/admin`, with whatever policy you want on it.
2. Copy the **Application Audience (AUD) Tag** and the **team domain** into `vars` in `wrangler.jsonc`. Both ship as `REPLACE-ME` placeholders, so **until you do this the Desk 404s for everyone**, which is the correct direction to be wrong in. Neither is a credential — they confer nothing without a JWT Cloudflare signed — which is why they live in committed config like the KV `id` and `database_id`.
3. The Access app produces no binding, so nothing in CI can see it drift. Record it in `docs/ARCHITECTURE.md`'s account inventory, which is its only inventory.

The path predicate is `src/lib/admin-path.js`, shared by middleware and the sitemap filter, because **three** things have to agree on it — those two and the Access app's own path pattern. A bare `startsWith('/admin')` also matches `/administrator`, the same trap `isPreviewHost` has with its leading dot. The sitemap filter is not cosmetic: an entry would publish the slug of every scheduled draft in a file crawlers are invited to read.

#### Looking at it locally

There is no Access in front of `wrangler dev`, so the Desk needs a key set you control:

```sh
just smoke     # mints its own keypair and asserts both directions — nothing to set up
```

For a browser, generate a keypair, put its JWKS in `ACCESS_JWKS_OVERRIDE` in `.dev.vars`, and send a matching token as `Cf-Access-Jwt-Assertion`. `scripts/smoke/access.mjs` is the working example of all three steps.

**That override replaces the trust root**, which is why it is `.dev.vars` only and why `just smoke` refuses to start when `.dev.vars` sets it: wrangler prefers `.dev.vars` over `--var`, so a value there would shadow smoke's own keypair and every Desk assertion would fail locally while CI passed. Never `wrangler secret put` it.

Smoke asserts `wrangler.jsonc` never declares the name, which closes the one route by which the trust root could be replaced in a committed, deployed, reviewable file. **A `wrangler secret put` of the same name is invisible to this repo and nothing can prove it is unset** — so if the gate ever behaves oddly, check that first.

#### Why it did not become a separate API

The tempting shape is a second Worker on `admin.mjrossi.com` sharing the D1 database. It was rejected because it needs `pubDate`, slug existence and the revision hash — the exact facts `src/lib/post-source.ts` exists to define **once**, because two definitions of that hash "would refuse every write". Isolation is real but it is paid for in the currency this codebase spends most carefully.

What the Desk *did* need was one owner per fact, and that is where the work went:

- `src/lib/links-store.js` / `src/lib/notes-store.js` — the SQL, against a duck-typed store, so the worker and the CLI run one copy. `scripts/d1-store.mjs` is the wrangler-backed store; `src/lib/sql-literal.js` is the escaping boundary under it.
- `src/lib/link-state.js` — `live` / `expired` / `revoked` / `spent` and the extend headroom, so the Desk and `just preview-roster` cannot disagree about what is outstanding.
- `reviewModel` in `src/lib/galley-render.js` — what a round says, rendered as markdown by the pull and as HTML by the Desk.

### Publishing

1. Create `src/content/blog/my-post.mdx` with frontmatter + body.
2. `npm run dev` — preview at `/blog/my-post`.
3. Commit + push. Cloudflare Workers rebuilds. `smoke.mjs` asserts the blog routes, RSS, and per-tag pages exist and list the expected posts.

## Newsletter

The blog index and the foot of every **published** post carry an email signup (`src/components/Subscribe.astro`, one implementation with a `line` / `card` variant) that forwards to Buttondown via `src/pages/api/subscribe.ts`. Buttondown polls `/blog/rss.xml` and emails new posts automatically — the publishing flow stays "write MDX, `git push`."

**Full detail in [docs/NEWSLETTER.md](docs/NEWSLETTER.md)**: the complete env-var sourcing table, and the operator-side Buttondown email design — three files in `docs/` that must be re-pasted into the dashboard by hand, one of which is pinned to `src/lib/identity.js` by smoke.

**JS carve-out:** this is one of the two client-side JavaScript carve-outs (the other is the galley review client). The Turnstile loader and submit handler load on `/blog` **and on every published post** — and that is where the carve-out stops. **Do not lift `Subscribe.astro` into `Base.astro` or any shared chrome, and do not render it on a draft:** `BlogPost.astro` gates the card on `isPublished`, so a galley reader never meets a signup form on the post they are reviewing. Smoke asserts the form is absent on `/`.

Env vars in brief — full sourcing in [docs/NEWSLETTER.md](docs/NEWSLETTER.md), ownership model in [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md):

| Variable | Read by | Source |
|---|---|---|
| `PUBLIC_TURNSTILE_SITE_KEY` | Astro build — baked into HTML | mise `[env]`; public by design |
| `BUTTONDOWN_API_KEY`, `TURNSTILE_SECRET_KEY` | Worker runtime | `.dev.vars` / `wrangler secret put` |
| `PREVIEW_SIGNING_KEY` | Worker runtime **and** `scripts/preview-link.mjs` | `.dev.vars` only — the one documented exception |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Worker runtime | `vars` in `wrangler.jsonc` — identifiers, not secrets |
| `ACCESS_JWKS_OVERRIDE` | Worker runtime | `.dev.vars` **only**, normally unset. Never `wrangler secret put` this. |

`Subscribe.astro` degrades gracefully when `PUBLIC_TURNSTILE_SITE_KEY` is missing — the form is omitted and a `console.error` logged, rather than 500ing all of `/blog` for visitors. A missing runtime secret returns `500 { error: 'turnstile_secret_missing' }` or `{ error: 'buttondown_key_missing' }`, naming the specific binding so the operator can fix it without reading Worker logs.

For Cloudflare Workers Builds to pick up `mise.toml`'s `[env]` block, the dashboard **build command** must activate mise: `mise install && mise exec -- npm run build`.

## Local development, environment, and smoke

**Full detail in [docs/ENVIRONMENT.md](docs/ENVIRONMENT.md)** — the mise/wrangler ownership model, the `mise.local.toml` traps, the smoke failure catalogue, and preview deploys.

```sh
cp mise.local.toml.example mise.local.toml   # PUBLIC_TURNSTILE_SITE_KEY
cp .dev.vars.example .dev.vars               # BUTTONDOWN_API_KEY, TURNSTILE_SECRET_KEY
```

- `npm run dev` — Astro only. No worker, no Turnstile, no `/api/*`, no database. Shows scheduled posts.
- `npm run preview` — full build + `wrangler dev` on **port 8788** (pinned, so links minted for it work under smoke too). The only way to exercise the form, the galley, or any endpoint. Builds in production mode, so it *hides* scheduled posts.
- `npm run smoke` — the post-build assertions. Always `npm run build && npm run smoke` together, or smoke reads the previous build.

**mise owns shell-level vars; wrangler owns worker runtime secrets.** No variable appears in both files, and no tool reads from the other's. Keeping worker secrets out of shell env is a small but real defence-in-depth boundary — **do not copy `BUTTONDOWN_API_KEY` or `TURNSTILE_SECRET_KEY` into `mise.local.toml`**, where they are invisible to review, inert at runtime, and exported into every process on the machine. `PREVIEW_SIGNING_KEY` there is worse than inert: it wins for *minting only*, so you start producing links the deployed site rejects with nothing saying why.

**Two gotchas account for most smoke failures:**

- **`PUBLIC_TURNSTILE_SITE_KEY` must be exported at build time, every time.** Without it the form never reaches the HTML and four assertions go red about the newsletter form, the Turnstile tag, the external handler, and the follow note. **The bug is build-time env, not the assertions.** Use `MISE_ENV=development mise exec -- npm run build`, or set `PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA` before the build.
- **A previous run left wrangler on port 8788** — `Address already in use`. Fix with `just kill-smoke`. The run *immediately after* a hard kill can fail once on an uncheckpointed D1 WAL; just run it again, and only investigate if it fails twice with no kill in between.

**Exit 75 means `wrangler dev` died mid-run, not that an assertion failed** — the report says so, and everything listed above that line is collateral. Usually a handler returned without reading a request body it was sent; `refuse` in `src/lib/server.ts` **drains** rather than cancels for exactly this reason.

## Syndication (social)

**Social syndication is manual.** Buttondown's LinkedIn and Bluesky automations sit behind a higher plan tier than this newsletter is on, so they do **not** fire. Facebook was never offered by Buttondown at all. The only thing a published post reaches automatically is **email**.

Do not write code, comments, or docs that assume a post fans out to social on its own — it doesn't.

```
new MDX → git push → Cloudflare build → /blog/rss.xml → Buttondown polls → email
                                              │
                                              └→ (by hand) LinkedIn · Bluesky · Facebook
```

### Posting workflow

1. Merge, wait for the Cloudflare build, then **load the post's URL yourself before sharing it.** `/blog`, tag pages, and the feed all carry `Cache-Control: public, max-age=3600`, so there's up to an hour of edge-cache lag — see "Scheduled publishing". A dead link in the first ten minutes is the failure mode worth avoiding.
2. Confirm the Buttondown email actually went out. Buttondown polls the feed; it is not instant.
3. Write and post to LinkedIn, Bluesky, and Facebook by hand. Each wants its own register: Bluesky has a hard 300-character limit, LinkedIn truncates at roughly the first 200 characters before "see more", and Facebook is the personal-audience one.

Because the posts are hand-written, they can say more than an automation would — see "If the plan is ever upgraded" for what is lost by automating.

### If the plan is ever upgraded

- **Setup**: Settings → Integrations (connect LinkedIn via OAuth, Bluesky via app password), then Settings → Automations → two new automations triggered on **When a newsletter is sent**, with actions **Create a LinkedIn post** and **Create a Bluesky post**.
- **The body is not templatable.** Those two automations expose no body field — the post is generated from the newsletter's title and canonical URL. That is a real downgrade from a hand-written post, so upgrading is not automatically the right call; it may be worth automating Bluesky (where the 300-character limit makes copy less valuable) and continuing to write LinkedIn by hand.
- **Stop posting manually the same day**, or the automation and a hand-written post will double up.
- **Facebook stays manual regardless** — Buttondown has no Facebook integration at any tier.

LinkedIn caveat that applies either way: Buttondown posts to your LinkedIn **profile** as a standard post. It cannot publish to LinkedIn **Newsletters** (LinkedIn's own newsletter product) — LinkedIn exposes no API for that surface. Posting by hand is the only route to a LinkedIn newsletter.

### Why manual, and why not in-repo

Building syndication into the Worker would mean owning OAuth refresh (LinkedIn tokens expire in 60 days), Bluesky app-password storage, rate limiting, retries, and dedup state — plus KV/D1, cron triggers, and smoke sad-paths, for a personal site that posts infrequently. At this volume, writing three short posts by hand costs less than any of that and produces better copy. **Don't pre-build it.** If posting volume ever makes automation worth it, upgrading the Buttondown plan is the cheaper move than owning the auth surface here.

**No code in this repo** owns syndication, and nothing in `docs/` tracks the social posts. The email template (`docs/buttondown-rss-template.md`) remains the only operator-managed surface.
