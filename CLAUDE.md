# CLAUDE.md

Guidance for Claude Code working in this repository. For the full architecture, deployment, and CI rundown, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

Astro 6 with the `@astrojs/cloudflare` adapter. Plain CSS, **two** scoped pieces of client JS: the `/blog` newsletter form (see "Newsletter") and the galley review client, which loads only on a signed review link (see "The galley"). Neither ever appears on an ordinary page. `output: 'server'` — every route runs in the Cloudflare worker by default; only `/404` opts back into static via `export const prerender = true`. `/blog/rss.xml` is intentionally on-demand (not prerendered) so scheduled posts can enter the feed at request time — see "Blog". `src/middleware.ts` sets `Cache-Control: public, max-age=3600` on every HTML response so the edge cache absorbs traffic while the dynamic edition line refreshes hourly. Build output: `dist/client/` (assets, served via the `ASSETS` binding in `wrangler.jsonc`) plus the server bundle in `dist/server/` that Wrangler deploys as the worker. Node 22 (pinned in `mise.toml`).

**Server endpoint convention:** anything that doesn't render a page (redirects, JSON APIs) lives under `src/pages/api/*`. All endpoints share `src/lib/server.ts` for security headers, env access, JSON parsing, and error responses.

## File map

- `src/layouts/Base.astro` — shared shell. Renders the full Broadsheet masthead on every page, with the name as an `<h1>` on `/` and as a link back to `/` on subpages. Builds the edition line (`Vol. <yearOffset> · No. <monthRoman> · <Month YYYY>`) at request time so it stays current without a scheduled rebuild.
- `src/components/ContactLinks.astro` — inline-SVG icon row (GitHub, LinkedIn, `/api/contact` email, Bluesky). Rendered twice per page (nav + footer); the smoke tests assert both occurrences.
- `src/components/BlogPostEntry.astro` — shared `<article class="post-entry">` card used by `blog/index.astro` and `blog/tag/[tag].astro`.
- `src/components/Figure.astro` — `<figure>` wrapper around `astro:assets` `<Image>` with an optional `<figcaption>`. Imported in `.mdx` posts when an inline image needs a visible caption separate from its `alt`.
- `src/components/diagrams/*.astro` — per-post explanatory diagrams as hand-authored **inline SVG**. Not site chrome; each is imported by exactly one `.mdx` post. Hand-authored rather than generated because the no-client-JS rule plus `script-src 'self'` rules out running mermaid in the browser, and pre-rendering it would mean a Puppeteer dev dependency and a house style that fights the Broadsheet palette. They emit their own `<figure class="post-figure post-diagram">` and reuse the existing `.post-figure` / `figcaption` rules — they do **not** go through `Figure.astro`, which requires `ImageMetadata`. Shared styling (`.post-diagram`, `.dg-*`) lives in `global.css`. See "Diagrams in posts" under Blog.
- `src/components/NewsletterSignup.astro` — newspaper-style email signup form. Rendered **only** in `src/pages/blog/index.astro` — the first of two carve-outs from the no-client-JS rule (the other is the galley). Loads Cloudflare Turnstile + a hoisted submit handler. Owns its own scoped `<style>` block (the `.newsletter-*` rules live with the component, not in `global.css`). Smoke asserts the form is present on `/blog` and absent on `/` (regression guard against accidental lifts into shared chrome).
- `src/components/PageHeader.astro` — shared interior-page header (`<h1>` + optional description + default slot for `.page-meta`). Used by `/work`, `/education`, `/urban-mobility`, `/privacy`, and `/blog/tag/[tag]`. `/blog` keeps its custom `.blog-header` since the RSS-link variant doesn't fit the prop shape.
- `src/components/PostTags.astro` — `<p class="post-tags">` chip list, rendered twice by `BlogPost.astro` (header and footer). Single source of truth for the tag-list markup.
- `src/pages/*.astro` — one file per route. Pages: `/` (About + Now), `/work`, `/education`, `/urban-mobility`, `/blog`, `/privacy`, `/404`. Output mode is `server`, so every page runs on-demand by default; only `/404` opts back into static via `export const prerender = true` (`/blog/rss.xml` renders on-demand so scheduled posts surface without a rebuild). `Cache-Control: public, max-age=3600` is applied centrally by `src/middleware.ts`, not per-page.
- `src/pages/api/contact.ts` — on-demand redirect. `GET /api/contact` returns 302 to `mailto:hello@mjrossi.com` so the address never appears in static HTML. Cloudflare's `_redirects` rejects `mailto:` destinations and the deploy is a Worker with Static Assets (not classic Pages), so `functions/` is unavailable.
- `src/pages/api/subscribe.ts` — on-demand POST endpoint. Receives `{ email, turnstileToken, company }` from the newsletter form, verifies the Turnstile token, forwards to Buttondown (default double-opt-in; passes `ip_address` so Buttondown's firewall can geo/reputation-score the request and avoid false-positive blocks). Treats already-subscribed as success to avoid leaking the subscriber list; surfaces other Buttondown 400s as `upstream_rejected` so the client falls back to the "email me to add you manually" message. Uses helpers from `src/lib/server.ts`.
- `src/lib/server.ts` — shared `/api/*` plumbing: `securityHeaders`, `getEnv()` / `tryGetEnv()`, `parseJson()`, `jsonOk()`, `jsonError()`, `methodNotAllowed()`. The single source of truth for server-endpoint conventions. `tryGetEnv()` is the fail-closed read — `cloudflare:workers` throws when touched outside the worker runtime, and swallowing that belongs here rather than in a try/catch at each call site.
- `src/env.d.ts` — types for Cloudflare runtime `Env` (`BUTTONDOWN_API_KEY`, `TURNSTILE_SECRET_KEY`) and Astro `ImportMetaEnv` (`PUBLIC_TURNSTILE_SITE_KEY`).
- `src/content.config.ts` — Zod schema for blog post frontmatter (single source of truth for required/optional fields and tag validation).
- `src/content/blog/<slug>.mdx` — one file per post (or `<slug>/index.mdx` when colocating images).
- `src/lib/blog.ts` — `getPublishedPosts`, `getAllTags`, `getPostsByTag`, plus the `dateFormatter` / `isoDate` / `postReadingTime` helpers used by `BlogPostEntry.astro`. The single boundary between content source and rendering — a future D1 migration swaps only this module. `getPublishedPosts` also enforces scheduled publishing: in production (`import.meta.env.PROD`) it hides any post whose `pubDate` is in the future; in dev those posts stay visible for preview. Because index, tag, and post routes all flow through it, that one filter gates every surface (RSS included, via the on-demand feed). All three helpers take an optional `{ showScheduled }` — passed from `Astro.locals` so `*.workers.dev` preview deploys show drafts — defaulting to hidden so a call site that forgets it fails closed. The per-post signed-link unlock is deliberately *not* threaded through here; see "Previewing a scheduled post".
- `src/lib/edition.ts` — `toRoman(n)` and `editionLine(now?)` for the masthead "Vol. X · No. Y · Month YYYY" line. Imported by `Base.astro` and rebuilt on every on-demand render so the line stays current without a scheduled rebuild.
- `src/layouts/BlogPost.astro` — post chrome (title, byline, tags, optional cover, back link).
- `src/pages/blog/index.astro`, `src/pages/blog/[...slug].astro`, `src/pages/blog/tag/[tag].astro`, `src/pages/blog/rss.xml.ts` — list, post, per-tag, and RSS routes.
- `src/styles/global.css` — all styles, imported once via `Base.astro`. Uses CSS custom properties.
- `astro.config.mjs` — Cloudflare adapter, MDX integration (for the blog), sitemap integration, Astro `Font` integration for Inter / Fraunces / Source Serif 4.
- `wrangler.jsonc` — Worker config; `ASSETS` binding points at `dist/client`. Also declares `SESSION` (KV). **`SESSION` is not a feature this site uses** — `@astrojs/cloudflare` injects it into the generated `dist/server/wrangler.json` whenever `config.session.driver` is unset, which is unconditional and has no clean off switch, so the binding exists on the deployed Worker either way. It is declared here so the resource is visible in the repo rather than only in generated output and the dashboard. `smoke.mjs` asserts `wrangler.jsonc` declares every binding the build emits, so a future adapter release that injects another one fails the build. The check is one-directional by design (generated ⊆ declared) — a binding declared here but dropped by the build is not flagged.
- `src/lib/schedule.js` — `isPublished(pubDate, now?)`, the scheduled-publishing predicate. Plain JS (like `csp.js`) so `node --test` can import it without `astro:content`. Unit-tested in `src/lib/schedule.test.js`; see "Scheduled publishing" under Blog.
- `src/lib/preview.js` — the two scheduled-post preview unlocks: `isPreviewHost(hostname)` (`*.workers.dev` branch/version hosts → show drafts, but **not** the Worker's own production alias) and `signPreviewToken` / `verifyPreviewGrant` (signed, expiring, single-post links). Also exports `newLinkId` / `LINK_ID_RE` — every token carries a link id naming its row in `preview_links`, which is what makes it revocable — and `WORKER_NAME`, which must stay equal to `name` in `wrangler.jsonc` (smoke asserts it). `signPreviewToken` takes the same object `verifyPreviewGrant` returns, so minting and verifying stay symmetric. Deliberately **DB-free**: the allowlist lookup lives in `src/lib/preview-links.js`, so this one module still runs in the worker, under `node --test`, and in `scripts/preview-link.mjs` — the code that mints links is the code that verifies them. Unit-tested in `src/lib/preview.test.js`; see "Previewing a scheduled post".
- `src/lib/preview-links.js` — `isLinkActive(DB, id)`, the `preview_links` allowlist lookup that makes a link revocable. Called by `src/middleware.ts`, and plain JS rather than inline in it for one reason: middleware imports `astro:middleware`, so `node --test` cannot load it, and this was the only fail-closed branch in the feature with no persistent test — `return false` in a bare `catch` is one character from `return true`. Takes the store as an argument (duck-typed, so a test passes a three-line stub) rather than importing a binding, which is what keeps `preview.js` DB-free as well. Unit-tested in `src/lib/preview-links.test.js`, which covers the two paths smoke cannot reach over HTTP: a missing `DB` binding and a store that throws.
- `scripts/preview-link.mjs` — mints a signed preview link (`npm run preview-link -- <slug> (--remote | --local) [--hours N] [--host URL] [--reviewer LABEL]`). Reads `PREVIEW_SIGNING_KEY` from the environment or `.dev.vars`; validates the slug against real content before signing. **Records the link in `preview_links` before printing the URL** — a link whose row failed to write would be refused on arrival, so a failed insert hands out nothing. URL on stdout, metadata (including the link id to revoke by) on stderr.
- `scripts/preview-roster.mjs` — lists and revokes preview links (`just preview-roster` / `just preview-roster-all` / `just preview-revoke`). The only inventory of issued links there is. `--all` lists every link across every post, grouped by post, because a link whose slug you have forgotten is otherwise unrevocable — the per-post scoping that matters in the worker doesn't apply to a CLI already authenticated as you. **Revoking stays per-post**, so a mistyped id can't withdraw another draft's link. No admin endpoint, same rationale as `galley-pull.mjs`.
- `scripts/database-target.mjs` — `chooseDatabase({ local, remote })` and `databaseLabel(local)`. Every operator script that touches D1 (`preview-link`, `preview-roster`, `galley-pull`) requires an explicit `--remote` or `--local` and prints which one it used. There is **no default**: `--local` used to be opt-in on a production default, so forgetting it silently wrote a real row, and pointing a read at the wrong database answered "no links minted" / "no notes" for one that was never queried. Both mistakes are invisible at the time. `smoke.mjs` is exempt — not operator-facing, and local by construction.
- `scripts/d1.mjs` — `DB_NAME`, `d1Query`, `d1Exec`, `d1Migrate`. The single place this repo shells out to `wrangler d1 execute`; throws rather than exiting so each caller keeps its own `die()` prefix. Preserves three distinct failure messages that must not collapse into one: unreachable database, unparseable output, and output that parsed but is not the `[{ results: [...] }]` shape. The third throws rather than returning `[]` — a silent empty result from `d1Query` would make `preview-roster` report "no links minted" for a table it never actually read, and that list is the only inventory of issued links there is.
- `scripts/links-db.mjs` — the only owner of `preview_links` SQL. Validates its own inputs (`SLUG_RE`, `LINK_ID_RE`, `Number.isInteger`), because wrangler's `--command` takes a string rather than bound parameters and that shape check is what makes the interpolation safe. `smoke.mjs` seeds fixtures through the same `recordLinks` production mints through.
- `scripts/content.mjs` — `resolvePostSource(slug)`, the `<slug>.mdx` / `<slug>/index.mdx` probe shared by `preview-link.mjs` and `galley-pull.mjs`.
- `scripts/dev-vars.mjs` — `readDevVar(name)`, the one `.dev.vars` parser shared by `preview-link.mjs` and `smoke.mjs`. Both sign preview tokens that the worker must then verify, so they have to agree byte-for-byte on quoting: if one strips surrounding quotes and the other doesn't, `PREVIEW_SIGNING_KEY="…"` makes smoke sign with a different key than wrangler injects, and the positive-path preview assertions fail locally while CI (which has no `.dev.vars`) passes. Same anti-drift rationale as `csp.js` / `security-headers.js`.
- `src/lib/security-headers.js` — `SECURITY_HEADERS`, the canonical non-CSP header set (HSTS, COOP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy). Imported by `src/middleware.ts` and `scripts/gen-headers.mjs` so the worker and the static `_headers` file can't drift. Same split-source rationale as `csp.js`.
- `src/middleware.ts` — applies `SECURITY_HEADERS` to **every** worker response (set-if-absent, so a route that chose a stricter value keeps it — `/api/*` sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`), then adds `Content-Security-Policy` and the default `Cache-Control: public, max-age=3600` to HTML responses only. Routes can override Cache-Control by setting it before middleware runs (e.g. prerendered `/404` emits `max-age=0` from Astro and middleware leaves it alone). `_headers` rules only apply to static asset responses served by the Cloudflare ASSETS binding; on-demand routes bypass that file, so middleware is the single source of truth for their headers. The all-responses scope matters for `/blog/rss.xml`, which went on-demand for scheduled publishing and would otherwise ship with no security headers at all. Middleware also resolves the two scheduled-post preview unlocks *before* the route runs, handing them to routes as `locals.showScheduled` / `locals.previewSlug` / `locals.previewReviewer`. For a signed link that means two checks, not one: the signature, and then a lookup in the `preview_links` allowlist that makes the link revocable (`isLinkActive` from `src/lib/preview-links.js`, fail-closed on a missing binding, a D1 error, a missing row, or a revoked one). Both happen only when a `?preview=` token is present, so the normal request path does no HMAC work and touches no database. When either unlock is active middleware — **overrides** `Cache-Control` to `no-store` and sets `X-Robots-Tag: noindex, nofollow`. That override is the single exception to the set-if-absent rule above, because the values it replaces (`max-age=3600`, and the RSS route's own header) are exactly what would cache a draft.
- `dist/client/_headers` — **generated**, not checked in. `scripts/gen-headers.mjs` writes it during `npm run build` from `src/lib/csp.js` + `src/lib/security-headers.js`, so the static-asset header set can't drift from what middleware applies to worker responses. Applies only to assets served by the Cloudflare ASSETS binding.
- `public/scripts/newsletter.js` — one of two client-side JS files. Served as a static asset (not bundled by Astro) so it loads as an external module from `/scripts/newsletter.js` and works under the strict `script-src 'self'` CSP. Imported only by `src/components/NewsletterSignup.astro`.
- `public/scripts/galley.js` — the other. The editorial review client: selection → anchored note. Same static-asset rationale. Loaded only by `src/components/GalleyMargin.astro`, which itself renders only on a signed review link, so this can never reach a publicly cacheable page. See "The galley".
- `src/lib/remark-source-anchors.js` — remark plugin stamping `data-src="<start>-<end>"` (MDX source lines) on every commentable block. Registered in `astro.config.mjs` under `markdown.remarkPlugins`. The anchoring half of the galley. **This is why `@astrojs/markdown-remark` is a direct dependency, pinned exact.** Sätteri is Astro's default Markdown processor and doesn't run remark plugins; setting `markdown.remarkPlugins` makes Astro swap the pipeline back to `unified()`, which it imports from `@astrojs/markdown-remark` — a package it declares only as an *optional peer*. It used to resolve anyway because npm hoisted `@astrojs/mdx`'s copy to the top level; a lockfile regeneration that nested it instead failed the build outright (`…is no longer installed by default now that Sätteri is the default Markdown processor`). Declaring it here makes the resolution ours rather than a hoisting accident. The pin must equal astro's `peerDependencies` entry — astro pins it exact and moves it on patch releases, so bump the two together.
- `src/lib/galley.js` — note validation + `sha256Hex`, shared by the write endpoint and the pull script. Plain JS, same rationale as `csp.js`.
- `src/lib/galley-relocate.js` — `unmark` / `fold` / `createLocator`, plus the fenced-and-blockquoted emitters for reviewer text. Split out of `galley-pull.mjs` because that script parses argv and shells out to wrangler at import time, so none of this was reachable from `node --test` — and it is the least obvious code in the feature. Unit-tested in `src/lib/galley-relocate.test.js`.
- `src/pages/api/galley.ts` — `GET`/`POST` galley notes. Authorisation comes entirely from `Astro.locals` (middleware has already verified the token); both methods require `previewReviewer`.
- `src/components/GalleyMargin.astro` — review chrome (bar, notes panel, composer). Owns its own scoped styles, like `NewsletterSignup.astro`.
- `scripts/galley-pull.mjs` — pulls notes into `docs/galley/<slug>.md` via `wrangler d1 execute`. No admin endpoint exists, because wrangler already authenticates the operator.
- `migrations/0001_initial.sql` — the whole D1 schema: `preview_links` (who may see a draft, and who may comment) and `galley_notes` (what they said). Apply with `wrangler d1 migrations apply mjrossi-galley --local|--remote`. One file because the feature shipped as one thing; the next schema change becomes `0002` and is append-only from then on, since a migration is frozen the moment it is applied anywhere real.
- `public/.assetsignore` — keeps worker artifacts out of the static asset binding.
- `scripts/smoke.mjs` — post-build smoke test. Checks static artifacts in `dist/client/` (CSS tokens, assets) and then spins up `wrangler dev` to hit every on-demand route. Run via `npm run smoke`.
- `scripts/make-noise.mjs`, `scripts/make-og.mjs` — one-off regenerators for `public/noise.png` and `public/og.png`.
- `.github/workflows/` — `build.yml` (build + smoke), `lighthouse.yml` (audits **production only** after a `main` deploy; pass/fail gate, no PR comment).

## Design system

CSS custom properties at `:root` in `src/styles/global.css` (warm-amber Broadsheet palette, light cream background):

- `--bg`, `--bg2` — cream page background and slightly darker secondary surface (oklch).
- `--border` — hairline rules and dividers.
- `--text`, `--muted` — primary and secondary text.
- `--accent` `#8f5520`, `--accent-hover` `#7a4a1a` — link color (AA against `--bg`).
- `--accent-surname` `#c97d3e` — the "Rossi" highlight in the masthead name.
- `--accent-band`, `--accent-band-border`, `--accent-rule`, `--accent-tagline` — masthead band, double-rule borders, hairlines, and the italic tagline color.
- `--font` (Source Serif 4) — body. `--font-serif` (Fraunces) — display. `--font-ui` (Inter) — nav and meta. All loaded via Astro's `Font` integration (`astro.config.mjs`) and exposed as CSS variables.
- `--max: 1100px`, `--pad: clamp(1.25rem, 4vw, 2.5rem)` — page width and gutter.

Section labels: `font-variant-caps: all-small-caps` with letter-spacing. Experience and education entries use `.entry` / `.entry-header` / `.entry-meta` / `.company` / `.role` / `.date`. Interior pages use `.page` / `.page-header` / `.page-meta`.

Smoke test asserts a handful of tokens on the built CSS bundle (`--max: 1100px`, `--accent: #8f5520`, no inline SVG data URIs) and then exercises every on-demand route through `wrangler dev`. Update `scripts/smoke.mjs` alongside any change to the tokens or chrome it pins.

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
- `src/pages/blog/tag/[tag].astro` — per-tag listings at `/blog/tag/<tag>`
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

### Frontmatter

```yaml
---
title: "Post title"
description: "One-line summary — used on list, OG, RSS"
pubDate: 2026-05-10        # a FUTURE date schedules the post — see below
updatedDate: 2026-05-12   # optional
tags: ["urban-mobility", "transit"]  # optional, must be kebab-case
cover:                     # optional
  src: "./cover.jpg"
  alt: "Alt text"
  caption: "Optional visible caption"
---
```

Invalid frontmatter fails the build. Committing a post with a past or present `pubDate` publishes it immediately.

**Scheduled publishing.** A post with a **future `pubDate`** can be merged to `main` and stays hidden in production — from the blog index, tag pages, its direct URL (which 404s), and the RSS feed — until that date passes, at which point it appears everywhere automatically with no rebuild or redeploy. This works because every one of those surfaces flows through `getPublishedPosts` (which filters future posts in production), and both the pages and the RSS feed are on-demand, so they re-evaluate "now" on each request. `pubDate` is a date, so the boundary is midnight UTC on that day. Future posts stay **visible in local `npm run dev`** for preview; note that `npm run preview` builds in production mode and therefore hides them exactly like production. There is no separate draft flag — a future date *is* the scheduling mechanism; use a git branch only if a post isn't ready to ship at all.

Two caveats worth knowing before scheduling a timed launch:

- **Expect up to an hour of lag, not instant publication.** `/blog`, tag pages, and the RSS feed all carry `Cache-Control: public, max-age=3600`, so a cached viewer can keep seeing the pre-publication version for up to an hour past midnight UTC, and Buttondown won't see the new item in the feed until its poll hits a fresh response. Don't schedule a post expecting it to be visible at an exact minute. (The post's own URL is safe from stale caching in the other direction — the 404 it serves while hidden carries no `Cache-Control`, so it isn't edge-cached.)
- **Images from a scheduled post are public before the post is.** `astro:assets` processes cover and inline images at build time, so they land in `dist/client/_astro/<name>.<hash>.ext` and are fetchable as soon as the build deploys. They're unlinked and hash-named, so effectively unguessable — but don't schedule a post whose cover image is itself the announcement.

The filter predicate lives in `src/lib/schedule.js` (plain JS, no `astro:content` import) and is unit-tested in `src/lib/schedule.test.js` via `npm test`. `smoke.mjs` separately asserts that `getPublishedPosts` still *calls* it — the unit tests alone would stay green if the filter were dropped from the call site.

#### Previewing a scheduled post

Two unlocks, both resolved in `src/middleware.ts` and both **fail-closed** (an unrecognised host with no valid signature hides drafts, exactly as production does). The predicates live in `src/lib/preview.js` — plain JS, same rationale as `schedule.js`, using `globalThis.crypto.subtle` so one module serves the worker, `node --test`, and the minting script.

**1. PR preview deploys — automatic.** Any request to a `*.workers.dev` **branch/version** hostname reveals *every* scheduled post, across the index, tag pages, post URLs, and RSS. Push a branch, open the Cloudflare preview URL, and your drafts are there. No secret and no flag — but see the dashboard caveat below, which is load-bearing.

The host check is an allowlist with two exclusions, both of which matter:

- Anchored on the leading dot, so `evil-workers.dev` does **not** match.
- **The Worker's own production alias does not match.** Cloudflare enables `<worker-name>.<subdomain>.workers.dev` by default, and it serves *production*. The subdomain is not a secret — it's recoverable from the Cloudflare check run on any commit, and from `docs/ARCHITECTURE.md`. Left unhandled, that hostname would hand every scheduled draft, RSS included, to anyone who read this repo, with no token at all — defeating the whole point of scoping signed links. `isPreviewHost` therefore rejects a hostname whose first label is exactly `WORKER_NAME`, **and** `wrangler.jsonc` sets `"workers_dev": false` to turn the alias off. `smoke.mjs` asserts both halves, including that `WORKER_NAME` still matches `name` in `wrangler.jsonc` — a rename that broke the pairing would silently re-open the hole.

**`preview_urls` must stay pinned to `true` in `wrangler.jsonc`, and this is not decoration.** Per-branch preview URLs are a separate setting from `workers_dev`, but they are not independent of it by default: `preview_urls` defaults to **false** in wrangler's config schema, and when the key is absent from the file wrangler resolves it from server-side state at deploy time — it warns that "your `preview_urls` setting is not in your Wrangler file" and then tracks the workers.dev route status, which `"workers_dev": false` just turned off. Left implicit, a deploy could therefore disable the very hostnames this unlock runs on, and it would look like a Cloudflare outage rather than a config change. wrangler warns about the `workers_dev: false` + `preview_urls: true` pairing but honours it.

Two things to know before pointing anything automated at a preview URL — both learned the hard way by a Lighthouse workflow that has since been scoped back to production for exactly these reasons (see `docs/ARCHITECTURE.md`):

- **Don't reconstruct the preview hostname — read it from Cloudflare's check run.** The alias is not just a slugified branch name; Cloudflare truncates it to 32 chars plus a 4-char hash. Slugifying a long dependabot branch yields a 76-character DNS label against a 63-character limit, which doesn't resolve at all.
- **These hosts are behind Cloudflare Access.** Anything automated that fetches a preview URL needs the `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` service token, or it silently gets a login page instead of the site — and handing that token to a preview Worker means handing it to whatever code that branch deployed, which is why fork PRs can never be audited this way. Note that this Access layer, not `isPreviewHost`, is currently what keeps scheduled drafts on preview hosts away from the public.

`localhost` and `127.0.0.1` are deliberately **excluded** — that keeps `npm run preview` and `npm run smoke` on the real production code path, which is what makes smoke's "no future-dated RSS items" assertion meaningful. Use `npm run dev` to preview drafts locally.

Host-based authorization is the weakest primitive here by construction: `context.url.hostname` comes from the request, so the unlock's strength is Cloudflare's routing, not this code. That is an acceptable trade for hiding drafts. Do not extend the pattern to anything that matters more.

**2. Signed expiring links — for the production domain.** Reveals **one** post, on any host:

```sh
npm run preview-link -- my-draft --remote                 # 48h, mjrossi.com
npm run preview-link -- my-draft --remote --hours 4
npm run preview-link -- my-draft --local --host http://127.0.0.1:8788
# → https://mjrossi.com/blog/my-draft/?preview=my-draft.1784634245.a1b2c3d4e5f60718.74ad2a0d…
```

The URL goes to stdout and the metadata to stderr, so it pipes cleanly. The script refuses to mint a link for a slug with no matching file — a typo would otherwise produce a valid-looking link that 404s.

**Signed links are scoped to the post's own URL and nothing else.** They do not add the draft to `/blog`, tag pages, or `/blog/rss.xml`. That is deliberate and load-bearing: the RSS feed is what triggers Buttondown's email — an irreversible send to real subscribers — so a link you hand to a reviewer must not be able to reach it. `getPublishedPosts` therefore takes only a boolean `showScheduled`; the per-slug signal (`Astro.locals.previewSlug`) is read solely by `src/pages/blog/[...slug].astro`.

`smoke.mjs` guards this two ways, because neither alone is sufficient:

- **Source greps** assert the post route still honours `previewSlug` and that the identifier has **not** leaked into `blog.ts` or the RSS route. Treat these as *diagnostics, not coverage*: the live matrix below strictly dominates them on the surfaces they check, and a leak written directly into `index.astro` or `tag/[tag].astro` passes all of them. What they buy is a fast, pre-`wrangler` failure that names the exact file and invariant — without them the same bug surfaces 90 seconds later as "a signed preview link reached the feed" with no pointer to where.
- **A live matrix** against `src/content/blog/smoke-scheduled-fixture.mdx`, a permanently future-dated fixture post (`pubDate: 2099-01-01`). Over HTTP it asserts the post is absent from `/blog` and RSS and 404s at its own URL with no token; that a valid signed token opens its own URL with `no-store` + `noindex`; that a validly-signed token minted for a *different* slug still 404s the fixture (the case a signature check alone cannot catch); and — the direction the source greps cannot see — that the **same valid token still leaves it absent from `/blog` and `/blog/rss.xml`**. The fixture exists because every real post is past-dated, so without it there is nothing for a leak to expose and the suite stays green through the bug.
- **Both directions of the host unlock**, by setting a `Host` header on requests to the local worker. A `smoke-<worker-name>.example.workers.dev` host must reveal the fixture on `/blog`, its own URL, *and* RSS (the host unlock is broader than a signed link by design) with `no-store` + `noindex`; the bare `<worker-name>.example.workers.dev` production alias must reveal nothing and stay cacheable. The positive direction is the one that matters operationally — `isPreviewHost` is a well-unit-tested pure function, but nothing else proves it is still *wired* to the routes, and a dropped `showScheduled` argument fails closed and would otherwise go unnoticed.

The fixture is visible in `npm run dev` and on `*.workers.dev` previews. That is expected — both surfaces show scheduled posts on purpose.

The token is `<slug>.<exp>.<linkId>.<hmac>`, or `<slug>.<exp>.<reviewer>.<linkId>.<hmac>` when it also grants galley notes. Every field except the signature is inside the signed payload, so a link minted for one draft cannot be edited to open another, a view-only link cannot have a reviewer spliced in, and the link id cannot be repointed at a different allowlist row. Verification uses `crypto.subtle.verify` (constant-time) and checks the signature *before* expiry.

Any response with either unlock active gets `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`, **overriding** whatever was set. This is the one place middleware overrides rather than setting-if-absent — a cached or indexed draft is precisely the failure being avoided.

#### Every link is revocable, and that is what `preview_links` is for

**A signature is necessary but not sufficient.** Every minted link — view-only and review alike — gets a row in the `preview_links` table, and `src/middleware.ts` requires that row, un-revoked, before the token grants anything. Withdraw one with:

```sh
just preview-roster my-draft --remote                     # what is outstanding, and its state
just preview-roster-all --remote                          # every link, across all posts
just preview-revoke my-draft a1b2c3d4e5f60718 --remote    # take one back
just preview-revoke my-draft --revoke-all --remote        # take back every live link
```

**Revoking removes reading as well as writing** — the post 404s for that link. Taking a draft back from someone should take the draft, not just the comment box. Rows are never deleted, so a withdrawn link stays listed as `revoked <date>` rather than vanishing from the inventory.

**The roster is the only inventory that exists.** A token is recorded nowhere else, so a link missing from it cannot be revoked, only waited out. `just preview-roster <slug>` answers for one post; **`just preview-roster-all` answers for every post**, which is the one to reach for when you can't remember which draft a link was minted for — without it, a forgotten slug meant a link you could not withdraw at all. `--hours` still matters regardless: mint with a window that matches the round (`--hours 96` for a week's reading, not the 48h default doubled "just in case"), because revocation needs someone to notice the link went astray before it helps.

**Minting now needs D1, and this is the accepted cost.** `just preview-link` writes its row before printing the URL — a link that verifies but has no row is refused on arrival, which looks exactly like the feature being broken, so a failed insert hands out nothing at all. That means minting against production needs an API token carrying **D1:Edit**, and minting for local work needs `--local` against a migrated database. While D1 is unavailable, no preview link works. That failure is recoverable and immediately visible; links that cannot be withdrawn are neither. `npm run dev` is unaffected — it shows scheduled posts outright, so preview links were never the local mechanism.

**Everything fails closed.** No signing key, no `DB` binding, a D1 error, a missing row, or a revoked row all resolve to no grant. There is deliberately no branch in this feature where a failure widens access.

**Neither pre-allowlist token shape verifies any more.** `<slug>.<exp>.<sig>` and `<slug>.<exp>.<reviewer>.<sig>` predate link ids and have no row to revoke, so honouring either would leave a permanent grant outside the allowlist. They were removed rather than deprecated because the galley had not shipped when this landed and no link of either shape was ever issued. Rotating `PREVIEW_SIGNING_KEY` remains the blunt instrument that invalidates everything at once.

Setup:

```sh
openssl rand -hex 32                      # generate
# → .dev.vars as PREVIEW_SIGNING_KEY (also read by scripts/preview-link.mjs)
wrangler secret put PREVIEW_SIGNING_KEY   # same value, production

wrangler d1 migrations apply mjrossi-galley --remote   # creates both tables
```

**The migration is not optional:** until it is applied, `preview_links` does not exist and *every* mint fails with "no such table" — view-only links included, not just review ones.

If `PREVIEW_SIGNING_KEY` is unset the worker rejects every link and only the `*.workers.dev` unlock remains — nothing else breaks.

Wherever a scheduled post is visible, it carries a `Scheduled` badge (`.post-scheduled`). The badge keys off `isPublished`, not the preview flag, so it can only ever appear on a post that isn't live.

### The galley

Inline editorial review. Editors open a link, read the real rendered post, select a passage, and leave a note. Notes come back anchored and structured, so applying them to the MDX is mechanical rather than interpretive. Named for the galley proof — the pre-publication print sent out for correction.

```sh
just preview-link my-draft --remote --reviewer jd   # one link per editor, mint with initials
just galley my-draft --remote                       # → docs/galley/my-draft.md
```

**The galley does not hand out access.** Links are minted, listed, and revoked with `just preview-link` / `preview-roster` / `preview-revoke` — one vocabulary for who may see a draft, whether or not they may comment on it. The galley owns the notes, the margin, the anchoring, and the pull. That boundary is why there is no `galley-link`: a command that issued access from inside the galley namespace is exactly what made revoking one feel like it belonged to a different feature.

**Git holds the post. D1 holds the conversation about the post.** That split is the whole design. Notes are ephemeral, relational collaboration state (many notes × many reviewers × per revision); a post is a durable versioned artifact whose git history is worth reading. Do not migrate posts into the database — `Figure`/`diagrams/*` compile at build time, `astro:assets` optimises images at build time, and frontmatter is Zod-validated at build time. All three would have to be rebuilt at runtime, and the editorial record in commit bodies would become an `updated_at` column.

**Authorisation is the preview token, extended.** A token is `<slug>.<exp>.<linkId>.<sig>` (view-only) or `<slug>.<exp>.<reviewer>.<linkId>.<sig>` (view + comment). The signed payload is every field except the signature, so the shape is authenticated: a view-only link can't have a reviewer spliced in, a review link can't be stripped back to look like a plain one, and neither can be repointed at a different allowlist row. Reviewer is read from the token, never from the request body, so a note can't be attributed to someone who didn't write it. Editors need no account and no GitHub.

**A review link can be withdrawn.** It is an ordinary preview link with a reviewer inside the signature, so it is recorded in `preview_links` and `just preview-revoke <slug> <id> --remote` takes it back — reading included, so the draft 404s for that link. `just preview-roster <slug> --remote` lists what is outstanding, and `just preview-roster-all --remote` lists every link across every post. See "Previewing a scheduled post" above for the full mechanism, the fail-closed behaviour, and the D1 dependency that minting now carries.

Two things that scoping does *not* solve, and still need judgement. Mint with a window that matches the round (`--hours 96` for a week's reading, not the 48h default doubled "just in case"), because revocation needs someone to notice the link went astray before it helps. And treat the write quota in `src/pages/api/galley.ts` as the bound in the meantime — 60 notes per reviewer per hour, asserted live in smoke.

**That quota is one SQL statement, and it has to stay one.** The count is a subquery inside the `INSERT ... SELECT ... WHERE`, and a refusal arrives as `meta.changes === 0` rather than as an error. Split back into a `SELECT COUNT(*)` followed by an `INSERT` and the bound holds only against a polite client: two round-trips let concurrent requests all read the same pre-flood count, all pass, and all insert. Smoke fires 90 notes in parallel and asserts no more than the quota lands — measured at 69 accepted against a cap of 60 with the check-then-insert version, so this is the observed behaviour and not a theoretical race.

The flood collects with `Promise.allSettled`, and the reason is worth keeping: under `Promise.all` one dropped connection rejects the whole batch, surfaces as `smoke: ERROR — fetch failed`, and takes the ~40 assertions after it down with no indication of which one mattered. `wrangler dev` drops connections under far less load than this — `fetchExpectingNon5xx` exists for exactly that. **But tolerance needs a floor under it**, which is what the `galley: the flood actually reached the endpoint` check is: `accepted <= quota` is vacuously true when nothing was accepted, so a run where the worker died mid-flood would otherwise go green on a dead endpoint. Verified by fault injection — dropping 70 of 90 requests fails the floor check while `accepted <= quota` still passes, which is precisely the false green the floor exists to convert into a red.

**The token rides in a URL, so `Referrer-Policy` is load-bearing.** A draft under review links outward like any other post, and `strict-origin-when-cross-origin` (from `src/lib/security-headers.js`) is what keeps `?preview=…` out of third-party referer logs. Relaxing that header to `unsafe-url` would hand every outstanding review link to every site a draft links to, silently and with nothing else in the system noticing.

**Anchoring is two-part, and both parts are load-bearing.** `remark-source-anchors` stamps `data-src="<start>-<end>"` on each block; the client records that range *plus* the quoted text and ~32 characters either side. The line range is exact but goes stale on the next revision — which is the normal case, since review happens in rounds. The quote survives revision but is ambiguous alone. Each note also stores a SHA-256 of the **whole .mdx file, frontmatter included** — anchors are absolute line numbers, so adding one tag shifts every one of them, and a body-only hash would call that "unchanged".

`galley-pull.mjs` compares that hash against the file and, where the quote is still findable, reports `now line N` with the current text. Where it isn't, it says so rather than printing a line number pointing at unrelated prose. Ambiguous matches deliberately resolve to nothing — confidently naming one of three identical sentences is how a note gets applied in the wrong section.

**Typography must be folded before searching.** Smartypants renders `'` as `’` and `--` as an em dash, so an editor's selection never matches the source byte-for-byte. `galley-relocate.js` folds both sides; without it every note would look like it had drifted.

**Inline markdown must be stripped from the source side, and only from the source side.** A quote comes from `block.textContent`, which carries no markup at all, while the search runs against raw `.mdx` — so a selection spanning a link, emphasis, or a code span is not a substring of the line holding it (`we shipped [the Atlas](…) last spring` vs `we shipped the Atlas last spring`). Every post here has inline links and editors select whole sentences, so without `unmark` the quote half of the anchor is dead exactly when the line range has gone stale and it is the only half left. One-directional on purpose: folding the quote side would mean guessing at markup the client already discarded, and a wrong guess produces a confident match on the *wrong* passage, whereas over-stripping the source merely fails to match — which is already reported safely.

**`data-src` ships on every block of every published post, not just drafts under review.** `remark-source-anchors` runs at build time, where there is no request to condition on — the alternative is a second build of the whole content collection, which is not worth it. The cost is ~15 bytes per block and the disclosure that a post's paragraphs occupy given MDX line numbers, which is public in this repo anyway. Worth knowing before treating a `data-src` in production HTML as a bug.

**Scope is unchanged from a read-only link.** A review link grants *writing*, not *reach*: still one post, still not `/blog`, still not tag pages, and above all still not `/blog/rss.xml` — the feed is what triggers Buttondown's irreversible send. `previewReviewer` must never reach `src/lib/blog.ts` or the RSS route; smoke greps for exactly that and separately proves it live.

**The second JS carve-out is tighter than the first.** `galley.js` loads only when `previewReviewer` is set *and* `previewSlug` matches the post being rendered — which is only ever true on a response middleware has already forced to `no-store` + `noindex`. It is structurally incapable of reaching a publicly cacheable page, where `newsletter.js` ships on every `/blog` hit. Don't loosen that gate in `BlogPost.astro`.

**The CSS does not inherit that gate for free, and this bit is easy to get wrong.** Astro hoists a processed `<style>` into the *route's* stylesheet from the static module graph, not from the runtime condition that renders the component — so a plain `<style>` in `GalleyMargin.astro` ships every `.galley-*` rule as a render-blocking stylesheet on every published post, invisibly, with no galley markup in the HTML to give it away. The block is therefore `is:inline`, which also happens to be the only way it works at all: scoped styles compile to `.galley-bar[data-astro-cid-…]`, and every element they target is created at runtime by `galley.js` via `createElement`, so it never carries the attribute. `smoke.mjs` asserts both directions — no `galley-` in the built CSS bundles, and no `galley-` in a published post's HTML.

**No admin surface.** Notes are read with `wrangler d1 execute`, which is already authenticated as you. The deployed worker has no way to list notes across posts, because handing someone one draft must not hand them the rest.

Setup, once:

```sh
wrangler d1 migrations apply mjrossi-galley --remote
```

**The API token needs D1 permissions.** This was a real failure once and is worth recognising if it recurs, but the token in `mise.local.toml` has D1 today — `wrangler d1 info mjrossi-galley` and `just galley <slug> --remote` both work.

`CLOUDFLARE_API_TOKEN` is set in the shell and wrangler prefers it over an OAuth login. If that token lacks D1, every `--remote` D1 command fails with:

```
The given account is not valid or is not authorized to access this service [code: 7403]
```

That is a token-scope problem, not a wrangler or account problem — the account is correct and `wrangler whoami` will happily list it. Fix by adding **D1:Edit** to the token at <https://dash.cloudflare.com/profile/api-tokens>, or by unsetting `CLOUDFLARE_API_TOKEN` and using `wrangler login`. Until then `just galley <slug> --local` is the only one that works; the deployed worker is unaffected, since it reaches D1 through its binding rather than the API.

Smoke migrates the local database itself — `wrangler dev` does not apply migrations on startup, and without that step the galley assertions fail with "no such table", which reads like a broken endpoint rather than an unmigrated fixture.

#### Trying the galley locally

The whole loop runs on your machine, against the local D1 that `just preview` and `just smoke` share. `npm run dev` is **not** the way in — it runs Astro alone, with no worker, no `/api/*`, and no database, so the margin cannot save anything. Use `just preview`.

```sh
just galley-migrate --local                  # once, and after any new migration
just preview                                 # build + wrangler dev on 127.0.0.1:8788

# in another shell — any post works, published or scheduled
just preview-link smoke-scheduled-fixture --local \
  --host http://127.0.0.1:8788 --reviewer jd
# → http://127.0.0.1:8788/blog/smoke-scheduled-fixture/?preview=…

# open that URL, select a sentence, leave a note, then:
just galley smoke-scheduled-fixture --local  # → docs/galley/<slug>.md
just preview-roster-all --local              # what you have minted locally
```

`smoke-scheduled-fixture` is the permanently future-dated fixture post, which makes it the natural target: it exercises the scheduled-post path as well as the galley, and it 404s without a token exactly as a real draft does.

Three things that will otherwise cost you time:

- **The port is 8788, and it is pinned for this reason.** `just preview` sets `--port 8788` (in `package.json`) rather than taking wrangler's default, so it matches `just smoke` and the `--host` above is the same in both. A link minted for one port simply 404s on the other — the host is inside the URL, not the signature, so nothing warns you.
- **`--local` is required, and it must match on both ends.** Minting writes the allowlist row; pulling reads the notes. Point either at the wrong database and you get a link refused on arrival, or "no notes" for a post that has them. Both messages now name the database they used, which is the fastest way to spot it.
- **Clean up after yourself if you used a real slug.** Local notes and links persist in `.wrangler/state` between runs. `just smoke` only clears its own fixture rows (`preview_links` for the fixture slug, and `galley_notes` for its own reviewer label), so a stray note left under another reviewer on the fixture post can skew smoke's counts. Delete it, or use a throwaway slug.

#### The authoring workflow this implies

**Branch preview URLs cannot be used for review.** `*.workers.dev` hosts sit behind Cloudflare Access, so an editor without a service token gets a login page instead of the post. Review therefore happens through signed links on `mjrossi.com`, which means the draft must already be on `main` with a future `pubDate`. Long-lived draft branches are incompatible with this feature.

1. Draft on a branch until it's a structurally complete first draft. Messy commits are fine — `main` is squash-only, so they never land.
2. PR → squash-merge to `main` with a future `pubDate` (~3 weeks out). One commit; hidden on every surface.
3. `just preview-link my-draft --remote --reviewer <initials>` per editor.
4. `just galley my-draft --remote` → apply → **one revision PR per review round**.
5. Set `pubDate` to the real date.

`main` gets ~2–4 commits per post. That is deliberate: the revision commits carry the editorial reasoning, and squashing them into the original post commit would destroy the most useful part of the history.

Accept knowingly: from step 2 the post exists in production storage. Every surface hides it, but its cover image is fetchable at an unguessable hashed `_astro/` URL — don't schedule a post whose cover image is itself the announcement.

### Publishing

1. Create `src/content/blog/my-post.mdx` with frontmatter + body.
2. `npm run dev` — preview at `/blog/my-post`.
3. Commit + push. Cloudflare Workers rebuilds. `smoke.mjs` asserts the blog routes, RSS, and per-tag pages exist and list the expected posts.

## Newsletter

The blog index has an email signup form (`src/components/NewsletterSignup.astro`) that forwards to Buttondown via `src/pages/api/subscribe.ts`. Buttondown polls `/blog/rss.xml` and emails new posts automatically — the publishing flow stays "write MDX, `git push`."

**JS carve-out:** This is one of two client-side JavaScript files (the other is the galley review client, which only loads on a signed review link). The Turnstile loader + form handler load *only* on `/blog`. Do not lift `NewsletterSignup.astro` into `Base.astro`, `BlogPost.astro`, or any shared chrome. Smoke asserts the form is absent on `/` as a regression guard.

**Env vars** (see `mise.local.toml.example` and `.dev.vars.example`):

| Variable | Where | Source (all environments) |
|---|---|---|
| `PUBLIC_TURNSTILE_SITE_KEY` | Astro build (`import.meta.env`) — baked into HTML | `mise.toml` `[env]` (commits the real production site key — it's public by design). `mise.development.toml` overrides with the always-passes test key when `MISE_ENV=development` (recommended local shell setting). `mise.ci.toml` does the same when `MISE_ENV=ci` (set in `build.yml`). `mise.local.toml` (gitignored) can override anything for machine-specific testing. |
| `BUTTONDOWN_API_KEY` | Worker runtime (`import { env } from 'cloudflare:workers'`) | `.dev.vars` locally; `wrangler secret put` in production |
| `TURNSTILE_SECRET_KEY` | Worker runtime (`import { env } from 'cloudflare:workers'`) | `.dev.vars` locally; `wrangler secret put` in production |
| `PREVIEW_SIGNING_KEY` | Worker runtime, **and** `scripts/preview-link.mjs` on the host | `.dev.vars` locally; `wrangler secret put` in production. Optional — unset means preview links are rejected and only the `*.workers.dev` unlock works. See "Previewing a scheduled post". |

For Cloudflare Workers Builds to pick up `mise.toml`'s `[env]` block, the **build command** in the dashboard must activate mise — `mise install && mise exec -- npm run build` (rather than the default `npm run build`). Cloudflare reads `[tools]` automatically but does not auto-activate `[env]`.

`NewsletterSignup.astro` gracefully degrades when `PUBLIC_TURNSTILE_SITE_KEY` is missing — the form is omitted and a `console.error` is logged to Worker observability, but the rest of `/blog` renders normally. (Because `/blog` is on-demand, `import.meta.env.PUBLIC_*` is inlined at build time but the missing-value check only fires at request time. Throwing here would 500 the entire blog for visitors; logging-and-omitting is the right trade.) If a runtime secret is missing, the endpoint returns `500 { error: 'turnstile_secret_missing' }` or `{ error: 'buttondown_key_missing' }` — names the specific binding so the operator can fix without checking Worker logs.

### Buttondown email design (operator-side)

The email design lives in three files in `docs/` — source of truth is the repo; Buttondown's dashboard is the copy that actually serves emails. Re-paste when these change:

| File | Buttondown slot |
|---|---|
| `docs/buttondown-rss-template.md` | RSS-to-email automation → **Template** field |
| `docs/buttondown-email-custom.css` | Email design → **Custom CSS** |
| `docs/buttondown-web-custom.css` | Web design → **Custom CSS** (Buttondown's hosted archive page) |

The Email design **Header** slot is text-only (inline HTML is emitted as literal characters), so the masthead ribbon — which needs a `<span>` for the two-tone accent on "LEXICON" — lives in the RSS template body, not the Header slot. Leave Header toggled off. Free-form broadcast emails therefore don't carry the masthead; RSS-to-email mailings do. RSS-to-email is the primary surface, so this is acceptable.

The RSS-to-email automation also has a separate **Subject** field (not in the repo, set in the dashboard). Use:

```
The Urbanist Lexicon · {{ item.title }}
```

Prefixing with the periodical name helps subscribers identify the email in a busy inbox.

**mise is the single source of truth for shell-level vars.** `mise.toml` pins Node 22 and commits the production `PUBLIC_TURNSTILE_SITE_KEY` (public by design). Two committed overrides switch in the always-passes Turnstile test key under specific contexts: `mise.development.toml` (when `MISE_ENV=development`, the recommended local-dev default) and `mise.ci.toml` (when `MISE_ENV=ci`, set in `.github/workflows/build.yml`). `mise.local.toml` (gitignored) remains available for machine-specific overrides on top of those. `jdx/mise-action` exports `[env]` to `GITHUB_ENV` so subsequent steps see the values. Cloudflare Workers Builds picks up `mise.toml` via the build command (`mise install && mise exec -- npm run build`).

### How mise and wrangler relate

These are two separate ownership layers; **no variable appears in both files, no tool reads from the other's file**, no circular dependency:

- **mise → shell env → Astro build.** mise's `[env]` table sets shell environment variables. Astro/Vite reads them via `process.env` / `import.meta.env` at build time. Only `PUBLIC_*` vars are ever surfaced this way — they're public by design (they end up in static HTML).
- **wrangler → `.dev.vars` → Worker runtime.** Wrangler dev reads `.dev.vars` at startup and injects the values into the Worker's `env` binding namespace. These never reach shell env, the browser, or any other tool's `process.env`. In production, `wrangler secret put` replaces `.dev.vars` (encrypted at rest in Cloudflare's secret store).

**mise does not pin wrangler, and must not start.** mise's own Node cookbook endorses declaring npm CLIs as mise `[tools]`, and that is right for tools the build merely *runs* (tsc, eslint). wrangler is not one: it is a `peerDependency` of `@astrojs/cloudflare` and is imported as a library by `@cloudflare/vite-plugin` during `astro build`, so it must resolve from `node_modules` no matter what — a mise pin could only ever duplicate the `package.json` one, never replace it. And a duplicate is not inert here, because wrangler bundles workerd and **workerd owns the schema of `.wrangler/state`**: an older wrangler cannot open state a newer one has written, and dies at runtime startup with `table _cf_ALARM has 3 columns but 2 values were supplied` / `The Workers runtime failed to start`. That message is version skew between two wranglers, not a corrupt database — the D1 rows are fine. This happened: `mise.development.toml` held 4.90.1 while `package.json` held 4.115.0, and `just galley-migrate --local` (the one recipe then calling bare `wrangler`) died before reaching the migration. The fix has three parts, all of which matter — every recipe and script invokes `npx wrangler`; `mise.toml` puts `{{config_root}}/node_modules/.bin` on PATH via `[env] _.path`, so a bare `wrangler` typed in the shell is also the pinned one; and `mise.development.toml` carries a note telling the next person not to re-add the pin.

That separation is intentional: keeping worker secrets out of shell env means only wrangler can see them — a small but real defense-in-depth boundary that we don't want to collapse just to centralise into one file. "Prefer mise where possible" means mise is the default for shell-level vars; wrangler's `.dev.vars` exists because runtime secrets belong to wrangler's contract, not because we're doubling up.

**One documented exception.** `PREVIEW_SIGNING_KEY` lives in `.dev.vars` like the others, but `scripts/preview-link.mjs` also reads it directly from that file when minting a link. HMAC has no way around this — the signing side and the verifying side must hold the same key, and the signing side is a local script. The exception is deliberately narrow: it's a signing key for unpublished blog drafts, not a credential for any external service, so the cost of the leak-surface it adds is small. Don't generalise from it — `BUTTONDOWN_API_KEY` and `TURNSTILE_SECRET_KEY` stay wrangler-only.

**`mise.local.toml` is the one file that can break this silently.** It is gitignored, so nothing in review or CI can see what it sets, and mise's `[env]` wins for shell-level vars. For the two wrangler-only secrets that makes a copy there invisible *and* inert: `wrangler dev` injects `.dev.vars` into the Worker's `env` binding regardless, and `src/pages/api/subscribe.ts` only ever reads `env.TURNSTILE_SECRET_KEY`, never `process.env`. So the copy does nothing except widen the blast radius — a production secret exported into every process on the machine. This happened with `TURNSTILE_SECRET_KEY` and was removed. If you are debugging `BUTTONDOWN_API_KEY` or `TURNSTILE_SECRET_KEY`, check `.dev.vars`; adding either to `mise.local.toml` will not help and should not be tried.

**`PREVIEW_SIGNING_KEY` is the exception to that, and it fails in the opposite direction — not inert, but split-brained.** `scripts/preview-link.mjs` reads `process.env.PREVIEW_SIGNING_KEY` *before* falling back to `.dev.vars`, so a value in `mise.local.toml` wins **for minting only**. The worker (which sees `.dev.vars` via `wrangler dev`) and `smoke.mjs` (which calls `readDevVar` exclusively) both keep the old key, so `npm run preview-link` starts producing links the site rejects, with nothing in the output saying why. That is precisely the signing/verifying drift `scripts/dev-vars.mjs` exists to prevent, reintroduced one layer up. Keep this key in `.dev.vars` only.

### Local development workflow

Both env files have `.example` siblings; copy and edit:

```
cp mise.local.toml.example mise.local.toml   # PUBLIC_TURNSTILE_SITE_KEY
cp .dev.vars.example .dev.vars               # BUTTONDOWN_API_KEY, TURNSTILE_SECRET_KEY
```

The defaults work end-to-end except for the actual Buttondown call (placeholder API key 401s, endpoint returns 502 to the client — visible in dev tools). Replace `BUTTONDOWN_API_KEY` with a real free-tier key for a full happy path.

Then:

- `npm run dev` — Astro dev server only. No worker, no Turnstile, no `/api/*` routes.
- `npm run preview` — full build + `wrangler dev`. Only way to exercise the form.
- `npm run smoke` — runs the post-build assertions including `/api/subscribe` sad paths.

#### Running smoke — read this before you debug a failure

**`PUBLIC_TURNSTILE_SITE_KEY` must be exported in the shell at build time, every time.** This trips people up regularly. `import.meta.env.PUBLIC_TURNSTILE_SITE_KEY` is inlined into the bundle by Vite during `astro build`; if the var isn't set when `npm run build` runs, the form never reaches the HTML and four smoke assertions go red:

```
✗ blog index: newsletter form present
✗ blog index: Turnstile script tag
✗ blog: submit handler is external (/scripts/newsletter.js) — no external /scripts/newsletter.js <script src> found in blog HTML
✗ blog: follow note is OUTSIDE the newsletter aside — blog-follow-note appears inside .newsletter — ad blockers will hide it
```

When you see that signature, the bug is **build-time env**, not the assertions. Rebuild with the var set.

The tidy way is to activate mise — `mise.development.toml` and `mise.ci.toml` both export the documented Turnstile always-passes test key (`1x00000000000000000000AA`):

```sh
MISE_ENV=development mise exec -- npm run build && npm run smoke
# or, if mise auto-activates via shell hook:
mise install && npm run build && npm run smoke
```

If mise isn't installed locally, set the test key directly before the build:

```sh
PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA npm run build && npm run smoke
```

CI handles this via `MISE_ENV=ci` in `.github/workflows/build.yml`, so the issue only bites in a fresh local shell without mise active.

**Other smoke gotchas worth knowing:**

- **`wrangler dev` died mid-run, and smoke exited 75.** A handler somewhere returned a response without reading the request body it was sent. `wrangler dev` puts a ProxyWorker between the client and the Worker, and an unread body leaves that hop holding a stream nobody drains; after enough of them the connection goes with `Network connection lost.`, wrangler's ProxyController treats that as fatal, and the dev server exits partway through the run. Production Cloudflare does not care, so this is a local-dev and CI failure only — but it takes out `just preview` too, for anyone whose review link has been revoked while the galley client keeps posting.

  `refuse` in `src/lib/server.ts` is the fix, and it **drains** (`arrayBuffer()`) rather than cancelling. That looks backwards — `request.body.cancel()` is the tidy-looking option — but cancelling does not release the hop. Measured against `/api/galley` with 400 unauthorised POSTs: no drain died at request 29, `cancel()` died at 20, `arrayBuffer()` went 400-for-400 and stayed up. Don't optimise it back to a cancel. Any new early return from a handler that can be sent a body belongs behind it; the one deliberate exception is `parseJson`'s 413, which is the single refusal that is *about* the body being too large.

  Recognise it by the report, which names it: `smoke: wrangler dev EXITED MID-RUN` (or `is NOT ANSWERING`), followed by the tail of wrangler's own log. Everything listed above that line is collateral — requests in flight when the runtime went away come back `500`, and the rest are refused. Before smoke knew to say so this surfaced as four galley assertions failing, including "a valid token wrote to a post it was not minted for", which is alarming and was never true. The exit code is 75 rather than 1 to keep that distinction machine-readable. CI does **not** retry it: that was tried, and both attempts died at the same check.

- **A previous smoke run left wrangler running.** The script spawns `wrangler dev` on port 8788 and traps SIGINT/SIGTERM to clean up, but a hard kill (timeout, `kill -9`, sandbox shutdown) leaves the process orphaned. Symptom: smoke prints `Address already in use (127.0.0.1:8788)` and bails. Fix: `just kill-smoke` (or `pkill -9 -f wrangler && pkill -9 -f workerd`, confirmed with `lsof -i :8788`), then re-run.
- **The run *after* a hard kill can fail once, and it does not look like a toolchain problem.** `kill -9` leaves the local D1 SQLite WAL uncheckpointed (`.wrangler/state/v3/d1/**/*.sqlite-wal`, which can be a couple of hundred KB), and the next `wrangler dev` startup is unreliable against it. Observed twice, both times immediately after a `pkill -9`: a galley check fails with `got 500` on a request that should never reach D1, then the worker dies and the rest of the run reports `smoke: ERROR — fetch failed`. Six runs with no preceding hard kill all passed. **Just run it again** — the state recovers on the next clean open. Only start investigating if it fails twice in a row without a kill in between.
- **Cold-start wrangler can take 30–60s** in slow environments. The script's internal `READY_TIMEOUT_MS` is 30s; if your wrapper has its own timeout, give smoke at least 2 minutes end-to-end.
- **Build is stale.** Smoke reads `dist/client/` plus on-demand routes from the worker bundle. If you tweak source files and run smoke without rebuilding, you're testing the previous build. Always `npm run build && npm run smoke` together (or use the chained commands above).

### Preview deploys

PR branches get preview URLs from Cloudflare Workers Builds. **Preview deploys currently share production secrets** — a subscription via a preview URL lands in the production Buttondown account. Acceptable for a personal site (preview URLs are `noindex`'d). `wrangler.jsonc` carries a commented scaffold for isolating preview into its own environment if that ever needs to change.

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
