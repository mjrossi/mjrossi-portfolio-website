# CLAUDE.md

Guidance for Claude Code working in this repository. For the full architecture, deployment, and CI rundown, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

Astro 6 with the `@astrojs/cloudflare` adapter. Plain CSS, no client-side JavaScript. `output: 'static'` — every route prerenders except `src/pages/contact.ts`, which is on-demand and runs in the Cloudflare worker. Build output: `dist/client/` (assets, served via the `ASSETS` binding in `wrangler.jsonc`) plus `dist/_worker.js` (the on-demand route). Node 22 (pinned in `mise.toml`).

## File map

- `src/layouts/Base.astro` — shared shell. Renders the full Broadsheet masthead on `/` (`section="home"`) and a condensed masthead elsewhere. Builds the edition line (`Vol. <yearOffset> · No. <monthRoman> · <Month YYYY>`) at request/build time — this is what the monthly rebuild cron exists to refresh.
- `src/components/ContactLinks.astro` — inline-SVG icon row (GitHub, LinkedIn, `/contact` email, Bluesky). Rendered twice per page (nav + footer); the smoke test asserts both occurrences.
- `src/pages/*.astro` — one file per route. Pages: `/` (About + Now), `/work`, `/education`, `/urban-mobility`, `/projects` (noindex placeholder, excluded from sitemap), `/404`.
- `src/pages/contact.ts` — on-demand endpoint (`export const prerender = false`). `GET /contact` returns 302 to `mailto:hello@mjrossi.com` so the address never appears in static HTML. Cloudflare's `_redirects` rejects `mailto:` destinations and the deploy is a Worker with Static Assets (not classic Pages), so `functions/` is unavailable; this route is the smallest dynamic surface that works.
- `src/styles/global.css` — all styles, imported once via `Base.astro`. Uses CSS custom properties.
- `astro.config.mjs` — Cloudflare adapter, sitemap integration (filters out `/projects`), Astro `Font` integration for Inter / Fraunces / Source Serif 4.
- `wrangler.jsonc` — Worker config; `ASSETS` binding points at `dist/client`.
- `public/_headers` — CSP and security headers (HSTS, COOP, X-Frame-Options, Referrer-Policy, Permissions-Policy).
- `public/.assetsignore` — keeps `_worker.js` and `_routes.json` out of the static asset binding.
- `scripts/smoke.mjs` — post-build assertions. Run via `npm run smoke`.
- `scripts/make-noise.mjs`, `scripts/make-og.mjs` — one-off regenerators for `public/noise.png` and `public/og.png`.
- `.github/workflows/` — `build.yml` (build + smoke), `lighthouse.yml` (audits CF deploys, sticky PR comment), `monthly-rebuild.yml` (1st-of-month deploy hook to refresh the edition line).

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

Smoke test asserts these tokens on the built CSS bundle (`--max: 1100px`, `--accent: #8f5520`, `noise.png` referenced, no inline SVG data URIs, no sub-12px font sizes). Update `scripts/smoke.mjs` alongside any change to the tokens it pins.

## Content

All copy lives in the page files under `src/pages/`. To add a project, add a file under `src/pages/projects/` or enable Astro Content Collections at `src/content/projects/` for Markdown-driven content.
