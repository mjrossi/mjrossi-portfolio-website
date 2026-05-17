# Technology Stack

**Analysis Date:** 2026-05-17

## Languages

**Primary:**
- TypeScript — all `src/` files: pages, components, layouts, API routes, lib modules
- JavaScript (ESM) — `src/lib/csp.js` (shared by Vite and plain Node), `public/scripts/newsletter.js` (client-side, static asset)

**Secondary:**
- MDX — blog posts in `src/content/blog/*.mdx` and `src/content/blog/<slug>/index.mdx`
- CSS — `src/styles/global.css` (all styles, no preprocessor)

## Runtime

**Environment:**
- Node 22 (pinned in `mise.toml` via `[tools] node = "22"`)
- Production runtime: Cloudflare Workers (V8 isolate, not Node)

**Package Manager:**
- npm
- Lockfile: `package-lock.json` (present, committed)

## Frameworks

**Core:**
- Astro 6.3.1 — SSR framework with `output: 'server'`; every route is on-demand by default. `/404` and `/blog/rss.xml` opt back into static via `export const prerender = true`
- `@astrojs/cloudflare` 13.5.0 — Cloudflare Workers adapter; images use `imageService: 'compile'`

**Content:**
- `@astrojs/mdx` 5.0.4 — MDX support for blog posts
- `@astrojs/rss` 4.0.18 — RSS feed generation at `/blog/rss.xml`
- `@astrojs/sitemap` 3.7.2 — auto-generated sitemap at `/sitemap-index.xml`

**Build/Dev:**
- Vite (bundled with Astro) — build pipeline; handles asset fingerprinting and `import.meta.env.*` inlining
- Wrangler 4.90.1 — local `wrangler dev` for full Worker simulation (`npm run preview`), deployment (`npm run deploy`), and secret management

## Key Dependencies

**Critical:**
- `@astrojs/cloudflare` 13.3.x — adapter; changed env access model from `Astro.locals.runtime.env` to `import { env } from 'cloudflare:workers'`. Must stay in sync with Astro 6
- `astro:content` — Content Collections with Zod schema validation; schema defined in `src/content.config.ts`. Invalid frontmatter fails the build
- `cloudflare:workers` — runtime env binding access pattern for all API routes (see `src/lib/server.ts`)

**Infrastructure:**
- `@astrojs/rss` 4.0.18 — RSS feed is the integration point for Buttondown's email automation
- Astro `Font` integration (built-in, `fontProviders.google()`) — loads Inter, Fraunces, Source Serif 4 from Google Fonts at build time; exposed as CSS variables

## Configuration

**Environment:**
- `mise.toml` — pins Node 22 and commits the production `PUBLIC_TURNSTILE_SITE_KEY` (public by design)
- `mise.development.toml` — overrides with Turnstile always-passes test key when `MISE_ENV=development`
- `mise.ci.toml` — overrides with Turnstile always-passes test key when `MISE_ENV=ci` (set in `build.yml`)
- `mise.local.toml` (gitignored) — machine-local overrides; template at `mise.local.toml.example`
- `.dev.vars` (gitignored) — Wrangler runtime secrets (`BUTTONDOWN_API_KEY`, `TURNSTILE_SECRET_KEY`) for local `wrangler dev`; template at `.dev.vars.example`
- Build-time env vars flow: mise `[env]` → shell env → Astro/Vite inlines `PUBLIC_*` into bundle
- Runtime secrets flow: `.dev.vars` → wrangler → Worker `env` binding (accessed via `cloudflare:workers`)

**Build:**
- `astro.config.mjs` — Cloudflare adapter, MDX, sitemap, font integration, Vite rollup asset-naming workaround (sanitizes `@_@` in chunk names to avoid Cloudflare 307 redirect loop)
- `wrangler.jsonc` — Worker config; compatibility date `2026-04-17`; flags: `global_fetch_strictly_public`, `nodejs_compat`; `ASSETS` binding points at `dist/client/`
- `scripts/gen-headers.mjs` — runs post-build to write `dist/client/_headers` from `src/lib/csp.js`

**CSP and security headers:**
- `src/lib/csp.js` — single source of truth for Content Security Policy string; imported by middleware and header generator
- `src/middleware.ts` — sets CSP + `Cache-Control: public, max-age=3600` on every HTML response
- `public/_headers` — generated artifact (via `scripts/gen-headers.mjs`) covering static asset responses from the ASSETS binding

## Platform Requirements

**Development:**
- Node 22 (via mise)
- Wrangler 4.90.1 (pinned in `mise.development.toml`)
- `MISE_ENV=development` recommended in shell for automatic test-key activation
- `npm run dev` — Astro dev server only (no Worker, no `/api/*` routes)
- `npm run preview` — full build + `wrangler dev` on port 8788 (required for form testing)
- `npm run smoke` — post-build smoke test via `scripts/smoke.mjs`

**Production:**
- Cloudflare Workers with Static Assets binding
- Build output: `dist/client/` (static assets via ASSETS binding) + Worker bundle in `dist/server/`
- Build command for Cloudflare Workers Builds: `mise install && mise exec -- npm run build` (required so `mise.toml [env]` is applied)
- Runtime secrets set via `wrangler secret put`

---

*Stack analysis: 2026-05-17*
