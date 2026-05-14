# CLAUDE.md

Guidance for Claude Code working in this repository. For the full architecture, deployment, and CI rundown, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

Astro 6 with the `@astrojs/cloudflare` adapter. Plain CSS, **one** scoped piece of client JS (the `/blog` newsletter form — see "Newsletter" below). Most routes prerender; `src/pages/index.astro` and the `src/pages/api/*` endpoints are on-demand and run in the Cloudflare worker. Build output: `dist/client/` (assets, served via the `ASSETS` binding in `wrangler.jsonc`) plus the server bundle in `dist/server/` that Wrangler deploys as the worker. Node 22 (pinned in `mise.toml`).

**Server endpoint convention:** anything that doesn't render a page (redirects, JSON APIs) lives under `src/pages/api/*`. All endpoints share `src/lib/server.ts` for security headers, env access, JSON parsing, and error responses.

## File map

- `src/layouts/Base.astro` — shared shell. Renders the full Broadsheet masthead on every page, with the name as an `<h1>` on `/` and as a link back to `/` on subpages. Builds the edition line (`Vol. <yearOffset> · No. <monthRoman> · <Month YYYY>`) at request time so it stays current without a scheduled rebuild.
- `src/components/ContactLinks.astro` — inline-SVG icon row (GitHub, LinkedIn, `/api/contact` email, Bluesky). Rendered twice per page (nav + footer); the smoke tests assert both occurrences.
- `src/components/BlogPostEntry.astro` — shared `<article class="post-entry">` card used by `blog/index.astro` and `blog/tag/[tag].astro`.
- `src/components/NewsletterSignup.astro` — newspaper-style email signup form. Rendered **only** in `src/pages/blog/index.astro` — this is the single carve-out from the no-client-JS rule. Loads Cloudflare Turnstile + a hoisted submit handler. Smoke asserts the form is present on `/blog` and absent on `/` (regression guard against accidental lifts into shared chrome).
- `src/pages/*.astro` — one file per route. Pages: `/` (About + Now), `/work`, `/education`, `/urban-mobility`, `/blog`, `/privacy`, `/404`. Everything except `/404` is on-demand (`export const prerender = false`) with `Cache-Control: public, max-age=3600`, so the edition line stays current and the edge cache absorbs traffic.
- `src/pages/api/contact.ts` — on-demand redirect. `GET /api/contact` returns 302 to `mailto:hello@mjrossi.com` so the address never appears in static HTML. Cloudflare's `_redirects` rejects `mailto:` destinations and the deploy is a Worker with Static Assets (not classic Pages), so `functions/` is unavailable.
- `src/pages/api/subscribe.ts` — on-demand POST endpoint. Receives `{ email, turnstileToken, company }` from the newsletter form, verifies the Turnstile token, forwards to Buttondown (`type: 'unactivated'` → double opt-in). Treats already-subscribed as success to avoid leaking the subscriber list. Uses helpers from `src/lib/server.ts`.
- `src/lib/server.ts` — shared `/api/*` plumbing: `securityHeaders`, `getEnv()`, `parseJson()`, `jsonOk()`, `jsonError()`, `methodNotAllowed()`. The single source of truth for server-endpoint conventions.
- `src/env.d.ts` — types for Cloudflare runtime `Env` (`BUTTONDOWN_API_KEY`, `TURNSTILE_SECRET_KEY`) and Astro `ImportMetaEnv` (`PUBLIC_TURNSTILE_SITE_KEY`).
- `src/content.config.ts` — Zod schema for blog post frontmatter (single source of truth for required/optional fields and tag validation).
- `src/content/blog/<slug>.mdx` — one file per post (or `<slug>/index.mdx` when colocating images).
- `src/lib/blog.ts` — `getPublishedPosts`, `getAllTags`, `getPostsByTag`, plus the `dateFormatter` / `isoDate` / `postReadingTime` helpers used by `BlogPostEntry.astro`. The single boundary between content source and rendering — a future D1 migration swaps only this module.
- `src/layouts/BlogPost.astro` — post chrome (title, byline, tags, optional cover, back link).
- `src/pages/blog/index.astro`, `src/pages/blog/[...slug].astro`, `src/pages/blog/tag/[tag].astro`, `src/pages/blog/rss.xml.ts` — list, post, per-tag, and RSS routes.
- `src/styles/global.css` — all styles, imported once via `Base.astro`. Uses CSS custom properties.
- `astro.config.mjs` — Cloudflare adapter, MDX integration (for the blog), sitemap integration, Astro `Font` integration for Inter / Fraunces / Source Serif 4.
- `wrangler.jsonc` — Worker config; `ASSETS` binding points at `dist/client`.
- `src/middleware.ts` — sets `Content-Security-Policy` (and any other response-level headers) on every HTML response. `public/_headers` rules only apply to static asset responses served by the Cloudflare ASSETS binding; on-demand HTML pages bypass that file, so middleware is the single source of truth for HTML CSP.
- `public/_headers` — security headers (HSTS, COOP, X-Frame-Options, Referrer-Policy, Permissions-Policy) and a fallback CSP for static asset responses. Kept in sync with `src/middleware.ts` for defense-in-depth.
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
- `src/pages/blog/rss.xml.ts` — RSS feed at `/blog/rss.xml`

### Frontmatter

```yaml
---
title: "Post title"
description: "One-line summary — used on list, OG, RSS"
pubDate: 2026-05-10
updatedDate: 2026-05-12   # optional
tags: ["urban-mobility", "transit"]  # optional, must be kebab-case
cover:                     # optional
  src: "./cover.jpg"
  alt: "Alt text"
---
```

Invalid frontmatter fails the build. Committing a post publishes it — there is no draft flag or scheduled-publish mechanism. Use a git branch if a post isn't ready to ship.

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

### Preview deploys

PR branches get preview URLs from Cloudflare Workers Builds. **Preview deploys currently share production secrets** — a subscription via a preview URL lands in the production Buttondown account. Acceptable for a personal site (preview URLs are `noindex`'d). `wrangler.jsonc` carries a commented scaffold for isolating preview into its own environment if that ever needs to change.
