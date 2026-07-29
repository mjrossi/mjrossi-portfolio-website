# CLAUDE.md

Guidance for Claude Code working in this repository. For the full architecture, deployment, and CI rundown, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

Astro 6 with the `@astrojs/cloudflare` adapter. Plain CSS, **one** scoped piece of client JS (the `/blog` newsletter form — see "Newsletter" below). `output: 'server'` — every route runs in the Cloudflare worker by default; only `/404` opts back into static via `export const prerender = true`. `/blog/rss.xml` is intentionally on-demand (not prerendered) so scheduled posts can enter the feed at request time — see "Blog". `src/middleware.ts` sets `Cache-Control: public, max-age=3600` on every HTML response so the edge cache absorbs traffic while the dynamic edition line refreshes hourly. Build output: `dist/client/` (assets, served via the `ASSETS` binding in `wrangler.jsonc`) plus the server bundle in `dist/server/` that Wrangler deploys as the worker. Node 22 (pinned in `mise.toml`).

**Server endpoint convention:** anything that doesn't render a page (redirects, JSON APIs) lives under `src/pages/api/*`. All endpoints share `src/lib/server.ts` for security headers, env access, JSON parsing, and error responses.

## File map

- `src/layouts/Base.astro` — shared shell. Renders the full Broadsheet masthead on every page, with the name as an `<h1>` on `/` and as a link back to `/` on subpages. Builds the edition line (`Vol. <yearOffset> · No. <monthRoman> · <Month YYYY>`) at request time so it stays current without a scheduled rebuild.
- `src/components/ContactLinks.astro` — inline-SVG icon row (GitHub, LinkedIn, `/api/contact` email, Bluesky). Rendered twice per page (nav + footer); the smoke tests assert both occurrences.
- `src/components/BlogPostEntry.astro` — shared `<article class="post-entry">` card used by `blog/index.astro` and `blog/tag/[tag].astro`.
- `src/components/Figure.astro` — `<figure>` wrapper around `astro:assets` `<Image>` with an optional `<figcaption>`. Imported in `.mdx` posts when an inline image needs a visible caption separate from its `alt`.
- `src/components/diagrams/*.astro` — per-post explanatory diagrams as hand-authored **inline SVG**. Not site chrome; each is imported by exactly one `.mdx` post. Hand-authored rather than generated because the no-client-JS rule plus `script-src 'self'` rules out running mermaid in the browser, and pre-rendering it would mean a Puppeteer dev dependency and a house style that fights the Broadsheet palette. They emit their own `<figure class="post-figure post-diagram">` and reuse the existing `.post-figure` / `figcaption` rules — they do **not** go through `Figure.astro`, which requires `ImageMetadata`. Shared styling (`.post-diagram`, `.dg-*`) lives in `global.css`. See "Diagrams in posts" under Blog.
- `src/components/NewsletterSignup.astro` — newspaper-style email signup form. Rendered **only** in `src/pages/blog/index.astro` — this is the single carve-out from the no-client-JS rule. Loads Cloudflare Turnstile + a hoisted submit handler. Owns its own scoped `<style>` block (the `.newsletter-*` rules live with the component, not in `global.css`). Smoke asserts the form is present on `/blog` and absent on `/` (regression guard against accidental lifts into shared chrome).
- `src/components/PageHeader.astro` — shared interior-page header (`<h1>` + optional description + default slot for `.page-meta`). Used by `/work`, `/education`, `/urban-mobility`, `/privacy`, and `/blog/tag/[tag]`. `/blog` keeps its custom `.blog-header` since the RSS-link variant doesn't fit the prop shape.
- `src/components/PostTags.astro` — `<p class="post-tags">` chip list, rendered twice by `BlogPost.astro` (header and footer). Single source of truth for the tag-list markup.
- `src/pages/*.astro` — one file per route. Pages: `/` (About + Now), `/work`, `/education`, `/urban-mobility`, `/blog`, `/privacy`, `/404`. Output mode is `server`, so every page runs on-demand by default; only `/404` opts back into static via `export const prerender = true` (`/blog/rss.xml` renders on-demand so scheduled posts surface without a rebuild). `Cache-Control: public, max-age=3600` is applied centrally by `src/middleware.ts`, not per-page.
- `src/pages/api/contact.ts` — on-demand redirect. `GET /api/contact` returns 302 to `mailto:hello@mjrossi.com` so the address never appears in static HTML. Cloudflare's `_redirects` rejects `mailto:` destinations and the deploy is a Worker with Static Assets (not classic Pages), so `functions/` is unavailable.
- `src/pages/api/subscribe.ts` — on-demand POST endpoint. Receives `{ email, turnstileToken, company }` from the newsletter form, verifies the Turnstile token, forwards to Buttondown (default double-opt-in; passes `ip_address` so Buttondown's firewall can geo/reputation-score the request and avoid false-positive blocks). Treats already-subscribed as success to avoid leaking the subscriber list; surfaces other Buttondown 400s as `upstream_rejected` so the client falls back to the "email me to add you manually" message. Uses helpers from `src/lib/server.ts`.
- `src/lib/server.ts` — shared `/api/*` plumbing: `securityHeaders`, `getEnv()`, `parseJson()`, `jsonOk()`, `jsonError()`, `methodNotAllowed()`. The single source of truth for server-endpoint conventions.
- `src/env.d.ts` — types for Cloudflare runtime `Env` (`BUTTONDOWN_API_KEY`, `TURNSTILE_SECRET_KEY`) and Astro `ImportMetaEnv` (`PUBLIC_TURNSTILE_SITE_KEY`).
- `src/content.config.ts` — Zod schema for blog post frontmatter (single source of truth for required/optional fields and tag validation).
- `src/content/blog/<slug>.mdx` — one file per post (or `<slug>/index.mdx` when colocating images).
- `src/lib/blog.ts` — `getPublishedPosts`, `getAllTags`, `getPostsByTag`, plus the `dateFormatter` / `isoDate` / `postReadingTime` helpers used by `BlogPostEntry.astro`. The single boundary between content source and rendering — a future D1 migration swaps only this module. `getPublishedPosts` also enforces scheduled publishing: in production (`import.meta.env.PROD`) it hides any post whose `pubDate` is in the future; in dev those posts stay visible for preview. Because index, tag, and post routes all flow through it, that one filter gates every surface (RSS included, via the on-demand feed). All three helpers take an optional `{ showScheduled }` — passed from `Astro.locals` so `*.workers.dev` preview deploys show drafts — defaulting to hidden so a call site that forgets it fails closed. The per-post signed-link unlock is deliberately *not* threaded through here; see "Previewing a scheduled post".
- `src/lib/edition.ts` — `toRoman(n)` and `editionLine(now?)` for the masthead "Vol. X · No. Y · Month YYYY" line. Imported by `Base.astro` and rebuilt on every on-demand render so the line stays current without a scheduled rebuild.
- `src/layouts/BlogPost.astro` — post chrome (title, byline, tags, optional cover, back link).
- `src/pages/blog/index.astro`, `src/pages/blog/[...slug].astro`, `src/pages/blog/tag/[tag].astro`, `src/pages/blog/rss.xml.ts` — list, post, per-tag, and RSS routes.
- `src/styles/global.css` — all styles, imported once via `Base.astro`. Uses CSS custom properties.
- `astro.config.mjs` — Cloudflare adapter, MDX integration (for the blog), sitemap integration, Astro `Font` integration for Inter / Fraunces / Source Serif 4.
- `wrangler.jsonc` — Worker config; `ASSETS` binding points at `dist/client`.
- `src/lib/schedule.js` — `isPublished(pubDate, now?)`, the scheduled-publishing predicate. Plain JS (like `csp.js`) so `node --test` can import it without `astro:content`. Unit-tested in `src/lib/schedule.test.js`; see "Scheduled publishing" under Blog.
- `src/lib/preview.js` — the two scheduled-post preview unlocks: `isPreviewHost(hostname)` (`*.workers.dev` branch/version hosts → show drafts, but **not** the Worker's own production alias) and `signPreviewToken` / `verifyPreviewToken` (signed, expiring, single-post links). Also exports `WORKER_NAME`, which must stay equal to `name` in `wrangler.jsonc` — smoke asserts it. Plain JS on `globalThis.crypto.subtle`, so the same module runs in the worker, under `node --test`, and in `scripts/preview-link.mjs` — the code that mints links is the code that verifies them. Unit-tested in `src/lib/preview.test.js`; see "Previewing a scheduled post".
- `scripts/preview-link.mjs` — mints a signed preview link (`npm run preview-link -- <slug> [--hours N] [--host URL]`). Reads `PREVIEW_SIGNING_KEY` from the environment or `.dev.vars`; validates the slug against real content before signing. URL on stdout, metadata on stderr.
- `scripts/dev-vars.mjs` — `readDevVar(name)`, the one `.dev.vars` parser shared by `preview-link.mjs` and `smoke.mjs`. Both sign preview tokens that the worker must then verify, so they have to agree byte-for-byte on quoting: if one strips surrounding quotes and the other doesn't, `PREVIEW_SIGNING_KEY="…"` makes smoke sign with a different key than wrangler injects, and the positive-path preview assertions fail locally while CI (which has no `.dev.vars`) passes. Same anti-drift rationale as `csp.js` / `security-headers.js`.
- `src/lib/security-headers.js` — `SECURITY_HEADERS`, the canonical non-CSP header set (HSTS, COOP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy). Imported by `src/middleware.ts` and `scripts/gen-headers.mjs` so the worker and the static `_headers` file can't drift. Same split-source rationale as `csp.js`.
- `src/middleware.ts` — applies `SECURITY_HEADERS` to **every** worker response (set-if-absent, so a route that chose a stricter value keeps it — `/api/*` sends `Referrer-Policy: no-referrer` and `Cache-Control: no-store`), then adds `Content-Security-Policy` and the default `Cache-Control: public, max-age=3600` to HTML responses only. Routes can override Cache-Control by setting it before middleware runs (e.g. prerendered `/404` emits `max-age=0` from Astro and middleware leaves it alone). `_headers` rules only apply to static asset responses served by the Cloudflare ASSETS binding; on-demand routes bypass that file, so middleware is the single source of truth for their headers. The all-responses scope matters for `/blog/rss.xml`, which went on-demand for scheduled publishing and would otherwise ship with no security headers at all. Middleware also resolves the two scheduled-post preview unlocks *before* the route runs, handing them to routes as `locals.showScheduled` / `locals.previewSlug`, and — when either is active — **overrides** `Cache-Control` to `no-store` and sets `X-Robots-Tag: noindex, nofollow`. That override is the single exception to the set-if-absent rule above, because the values it replaces (`max-age=3600`, and the RSS route's own header) are exactly what would cache a draft.
- `dist/client/_headers` — **generated**, not checked in. `scripts/gen-headers.mjs` writes it during `npm run build` from `src/lib/csp.js` + `src/lib/security-headers.js`, so the static-asset header set can't drift from what middleware applies to worker responses. Applies only to assets served by the Cloudflare ASSETS binding.
- `public/scripts/newsletter.js` — the only client-side JS on the site. Served as a static asset (not bundled by Astro) so it loads as an external module from `/scripts/newsletter.js` and works under the strict `script-src 'self'` CSP. Imported only by `src/components/NewsletterSignup.astro`.
- `public/.assetsignore` — keeps worker artifacts out of the static asset binding.
- `scripts/smoke.mjs` — post-build smoke test. Checks static artifacts in `dist/client/` (CSS tokens, assets) and then spins up `wrangler dev` to hit every on-demand route. Run via `npm run smoke`.
- `scripts/make-noise.mjs`, `scripts/make-og.mjs` — one-off regenerators for `public/noise.png` and `public/og.png`.
- `.github/workflows/` — `build.yml` (build + smoke), `lighthouse.yml` (audits CF deploys, sticky PR comment).

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
- **The Worker's own production alias does not match.** Cloudflare enables `<worker-name>.<subdomain>.workers.dev` by default, and it serves *production*. The subdomain is not a secret — it's committed in `.github/workflows/lighthouse.yml`. Left unhandled, that hostname would hand every scheduled draft, RSS included, to anyone who read this repo, with no token at all — defeating the whole point of scoping signed links. `isPreviewHost` therefore rejects a hostname whose first label is exactly `WORKER_NAME`, **and** `wrangler.jsonc` sets `"workers_dev": false` to turn the alias off. `smoke.mjs` asserts both halves, including that `WORKER_NAME` still matches `name` in `wrangler.jsonc` — a rename that broke the pairing would silently re-open the hole.

**`preview_urls` must stay pinned to `true` in `wrangler.jsonc`, and this is not decoration.** Per-branch preview URLs are a separate setting from `workers_dev`, but they are not independent of it by default: `preview_urls` defaults to **false** in wrangler's config schema, and when the key is absent from the file wrangler resolves it from server-side state at deploy time — it warns that "your `preview_urls` setting is not in your Wrangler file" and then tracks the workers.dev route status, which `"workers_dev": false` just turned off. Left implicit, a deploy could therefore disable the very hostnames this unlock runs on **and** break `.github/workflows/lighthouse.yml`, which audits every PR at `<alias>-<name>.<subdomain>.workers.dev`. Both would fail at once and look like a Cloudflare outage rather than a config change. wrangler warns about the `workers_dev: false` + `preview_urls: true` pairing but honours it.

`localhost` and `127.0.0.1` are deliberately **excluded** — that keeps `npm run preview` and `npm run smoke` on the real production code path, which is what makes smoke's "no future-dated RSS items" assertion meaningful. Use `npm run dev` to preview drafts locally.

Host-based authorization is the weakest primitive here by construction: `context.url.hostname` comes from the request, so the unlock's strength is Cloudflare's routing, not this code. That is an acceptable trade for hiding drafts. Do not extend the pattern to anything that matters more.

**2. Signed expiring links — for the production domain.** Reveals **one** post, on any host:

```sh
npm run preview-link -- my-draft                          # 48h, mjrossi.com
npm run preview-link -- my-draft --hours 4
npm run preview-link -- my-draft --host http://127.0.0.1:8788
# → https://mjrossi.com/blog/my-draft/?preview=my-draft.1784634245.74ad2a0d…
```

The URL goes to stdout and the metadata to stderr, so it pipes cleanly. The script refuses to mint a link for a slug with no matching file — a typo would otherwise produce a valid-looking link that 404s.

**Signed links are scoped to the post's own URL and nothing else.** They do not add the draft to `/blog`, tag pages, or `/blog/rss.xml`. That is deliberate and load-bearing: the RSS feed is what triggers Buttondown's email — an irreversible send to real subscribers — so a link you hand to a reviewer must not be able to reach it. `getPublishedPosts` therefore takes only a boolean `showScheduled`; the per-slug signal (`Astro.locals.previewSlug`) is read solely by `src/pages/blog/[...slug].astro`.

`smoke.mjs` guards this two ways, because neither alone is sufficient:

- **Source greps** assert the post route still honours `previewSlug` and that the identifier has **not** leaked into `blog.ts` or the RSS route. Treat these as *diagnostics, not coverage*: the live matrix below strictly dominates them on the surfaces they check, and a leak written directly into `index.astro` or `tag/[tag].astro` passes all of them. What they buy is a fast, pre-`wrangler` failure that names the exact file and invariant — without them the same bug surfaces 90 seconds later as "a signed preview link reached the feed" with no pointer to where.
- **A live matrix** against `src/content/blog/smoke-scheduled-fixture.mdx`, a permanently future-dated fixture post (`pubDate: 2099-01-01`). Over HTTP it asserts the post is absent from `/blog` and RSS and 404s at its own URL with no token; that a valid signed token opens its own URL with `no-store` + `noindex`; that a validly-signed token minted for a *different* slug still 404s the fixture (the case a signature check alone cannot catch); and — the direction the source greps cannot see — that the **same valid token still leaves it absent from `/blog` and `/blog/rss.xml`**. The fixture exists because every real post is past-dated, so without it there is nothing for a leak to expose and the suite stays green through the bug.
- **Both directions of the host unlock**, by setting a `Host` header on requests to the local worker. A `smoke-<worker-name>.example.workers.dev` host must reveal the fixture on `/blog`, its own URL, *and* RSS (the host unlock is broader than a signed link by design) with `no-store` + `noindex`; the bare `<worker-name>.example.workers.dev` production alias must reveal nothing and stay cacheable. The positive direction is the one that matters operationally — `isPreviewHost` is a well-unit-tested pure function, but nothing else proves it is still *wired* to the routes, and a dropped `showScheduled` argument fails closed and would otherwise go unnoticed.

The fixture is visible in `npm run dev` and on `*.workers.dev` previews. That is expected — both surfaces show scheduled posts on purpose.

The token is `<slug>.<exp>.<hmac>`; the slug is inside the signed payload, so a link minted for one draft cannot be edited to open another. Verification uses `crypto.subtle.verify` (constant-time) and checks the signature *before* expiry.

Any response with either unlock active gets `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`, **overriding** whatever was set. This is the one place middleware overrides rather than setting-if-absent — a cached or indexed draft is precisely the failure being avoided.

Setup:

```sh
openssl rand -hex 32                      # generate
# → .dev.vars as PREVIEW_SIGNING_KEY (also read by scripts/preview-link.mjs)
wrangler secret put PREVIEW_SIGNING_KEY   # same value, production
```

If `PREVIEW_SIGNING_KEY` is unset the worker rejects every link and only the `*.workers.dev` unlock remains — nothing else breaks.

Wherever a scheduled post is visible, it carries a `Scheduled · <date>` badge (`.post-scheduled`). The badge keys off `isPublished`, not the preview flag, so it can only ever appear on a post that isn't live.

### Publishing

1. Create `src/content/blog/my-post.mdx` with frontmatter + body.
2. `npm run dev` — preview at `/blog/my-post`.
3. Commit + push. Cloudflare Workers rebuilds. `smoke.mjs` asserts the blog routes, RSS, and per-tag pages exist and list the expected posts.

## Newsletter

The blog index has an email signup form (`src/components/NewsletterSignup.astro`) that forwards to Buttondown via `src/pages/api/subscribe.ts`. Buttondown polls `/blog/rss.xml` and emails new posts automatically — the publishing flow stays "write MDX, `git push`."

**JS carve-out:** This is the only client-side JavaScript on the site. The Turnstile loader + form handler load *only* on `/blog`. Do not lift `NewsletterSignup.astro` into `Base.astro`, `BlogPost.astro`, or any shared chrome. Smoke asserts the form is absent on `/` as a regression guard.

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

That separation is intentional: keeping worker secrets out of shell env means only wrangler can see them — a small but real defense-in-depth boundary that we don't want to collapse just to centralise into one file. "Prefer mise where possible" means mise is the default for shell-level vars; wrangler's `.dev.vars` exists because runtime secrets belong to wrangler's contract, not because we're doubling up.

**One documented exception.** `PREVIEW_SIGNING_KEY` lives in `.dev.vars` like the others, but `scripts/preview-link.mjs` also reads it directly from that file when minting a link. HMAC has no way around this — the signing side and the verifying side must hold the same key, and the signing side is a local script. The exception is deliberately narrow: it's a signing key for unpublished blog drafts, not a credential for any external service, so the cost of the leak-surface it adds is small. Don't generalise from it — `BUTTONDOWN_API_KEY` and `TURNSTILE_SECRET_KEY` stay wrangler-only.

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

- **A previous smoke run left wrangler running.** This is the single most common local failure, and it has *two* different symptoms — see the next bullet, which is the same root cause wearing a disguise. The script spawns `wrangler dev` on port 8788 and traps SIGINT/SIGTERM to clean up, but a hard kill (timeout, `kill -9`, sandbox shutdown) or an interrupted agent turn leaves the process orphaned. Symptom: smoke prints `Address already in use (127.0.0.1:8788)` and bails.

  Fix — match on the **binary path** and kill by PID, then verify the count is zero before doing anything else:

  ```sh
  ps -eo pid,args --no-headers | awk '/bin\/workerd|wrangler-dist/ && !/awk/ {print $1}' \
    | while read p; do kill -9 "$p"; done
  ps -eo pid,args --no-headers | awk '/bin\/workerd|wrangler-dist/ && !/awk/' | wc -l   # must be 0
  ```

  **Do not use `pkill -f wrangler`.** The pattern text appears in the command line of the shell you type it in, so pkill matches your own session and kills it — you get a silent non-zero exit and nothing cleaned up. Bracket tricks (`"[w]rangler"`) are unreliable here too, because the command may be re-quoted through an `eval` wrapper before pkill sees it. Path-anchored `ps | awk | kill` is the only form that has worked consistently.
- **Cold-start wrangler can take 30–60s** in slow environments. The script's internal `READY_TIMEOUT_MS` is 30s; if your wrapper has its own timeout, give smoke at least 2 minutes end-to-end.
- **Build is stale.** Smoke reads `dist/client/` plus on-demand routes from the worker bundle. If you tweak source files and run smoke without rebuilding, you're testing the previous build. Always `npm run build && npm run smoke` together (or use the chained commands above).
- **An orphaned wrangler also breaks the *next build*, not just the next smoke.** Same root cause as the bullet above; entirely different-looking failure. The build's prerender step boots its own workerd via `@astrojs/cloudflare`, and if a stray `wrangler dev` is still alive holding miniflare's local SQLite state in `.wrangler/state`, the build's runtime collides with it and dies. Symptom is a build failure that reads like a broken binary rather than a stale process:

  ```
  *** Fatal uncaught kj::Exception: workerd/util/sqlite.c++:844: failed: SENTRY_DO SQLite failed;
  dbErrorMessage(...) = table _cf_ALARM has 3 columns but 2 values were supplied: SQLITE_ERROR
  MiniflareCoreError [ERR_RUNTIME_FAILURE]: The Workers runtime failed to start.
  ```

  Note the misdirection: the build that fails is the one *after* the smoke run, so the source change you just made looks like the cause and isn't.

  **Fix in this order — the order is the whole trick.**

  1. Kill the processes using the `ps | awk | kill` form above, and **verify the count is zero.**
  2. `rm -rf .wrangler /tmp/miniflare-*` — both. `.wrangler` is gitignored and safe to delete; miniflare also leaves scratch directories in `/tmp` that outlive the run.
  3. Rebuild.

  Each step alone looks like it works and then doesn't, which is why this took three passes to pin down. Deleting the directories while a stray process is alive is useless — it recreates them and the next build fails identically. Killing without deleting leaves the poisoned SQLite behind. And checking for stray processes *before* a failed build tells you nothing, because the failed build spawns its own that linger for the next one.

  Note also that a **successful** `npm run smoke` leaves workerd running. This is routine, not a crash artifact, so assume you need step 1 every time rather than only after something has gone wrong. Observed on Astro 7 / wrangler 4 in the Linux sandbox; CI starts from a clean checkout with no long-lived processes, so it never hits this.

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
