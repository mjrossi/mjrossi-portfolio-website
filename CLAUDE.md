# CLAUDE.md

Guidance for Claude Code working in this repository. For the full architecture, deployment, and CI rundown, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Stack

Astro 6 with the `@astrojs/cloudflare` adapter. Plain CSS, no client-side JavaScript. Most routes prerender; `src/pages/index.astro` and `src/pages/contact.ts` are on-demand and run in the Cloudflare worker. Build output: `dist/client/` (assets, served via the `ASSETS` binding in `wrangler.jsonc`) plus the server bundle in `dist/server/` that Wrangler deploys as the worker. Node 22 (pinned in `mise.toml`).

## File map

- `src/layouts/Base.astro` — shared shell. Renders the full Broadsheet masthead on `/` (`section="home"`) and a condensed masthead elsewhere. Builds the edition line (`Vol. <yearOffset> · No. <monthRoman> · <Month YYYY>`) at request time on `/` (on-demand render) so it stays current without a scheduled rebuild.
- `src/components/ContactLinks.astro` — inline-SVG icon row (GitHub, LinkedIn, `/contact` email, Bluesky). Rendered twice per page (nav + footer); the smoke tests assert both occurrences.
- `src/components/BlogPostEntry.astro` — shared `<article class="post-entry">` card used by `blog/index.astro` and `blog/tag/[tag].astro`.
- `src/pages/*.astro` — one file per route. Pages: `/` (About + Now, on-demand), `/work`, `/education`, `/urban-mobility`, `/blog`, `/404`.
- `src/pages/index.astro` — on-demand (`export const prerender = false`) with `Cache-Control: public, max-age=3600`. Keeps the edition line current; edge cache absorbs traffic.
- `src/pages/contact.ts` — on-demand endpoint. `GET /contact` returns 302 to `mailto:hello@mjrossi.com` so the address never appears in static HTML. Cloudflare's `_redirects` rejects `mailto:` destinations and the deploy is a Worker with Static Assets (not classic Pages), so `functions/` is unavailable.
- `src/content.config.ts` — Zod schema for blog post frontmatter (single source of truth for required/optional fields and tag validation).
- `src/content/blog/<slug>.mdx` — one file per post (or `<slug>/index.mdx` when colocating images).
- `src/lib/blog.ts` — `getPublishedPosts`, `getAllTags`, `getPostsByTag`, plus the `dateFormatter` / `isoDate` / `postReadingTime` helpers used by `BlogPostEntry.astro`. The single boundary between content source and rendering — a future D1 migration swaps only this module.
- `src/layouts/BlogPost.astro` — post chrome (title, byline, tags, optional cover, back link).
- `src/pages/blog/index.astro`, `src/pages/blog/[...slug].astro`, `src/pages/blog/tag/[tag].astro`, `src/pages/blog/rss.xml.ts` — list, post, per-tag, and RSS routes.
- `src/styles/global.css` — all styles, imported once via `Base.astro`. Uses CSS custom properties.
- `astro.config.mjs` — Cloudflare adapter, MDX integration (for the blog), sitemap integration, Astro `Font` integration for Inter / Fraunces / Source Serif 4.
- `wrangler.jsonc` — Worker config; `ASSETS` binding points at `dist/client`.
- `public/_headers` — CSP and security headers (HSTS, COOP, X-Frame-Options, Referrer-Policy, Permissions-Policy).
- `public/.assetsignore` — keeps worker artifacts out of the static asset binding.
- `scripts/smoke.mjs` — post-build assertions over `dist/client/` (prerendered routes + CSS tokens). Run via `npm run smoke`.
- `scripts/worker-smoke.mjs` — spins up `wrangler dev` and asserts the on-demand `/` renders correctly with the right `Cache-Control`. Run via `npm run worker-smoke`.
- `scripts/make-noise.mjs`, `scripts/make-og.mjs` — one-off regenerators for `public/noise.png` and `public/og.png`.
- `.github/workflows/` — `build.yml` (build + both smoke tests), `lighthouse.yml` (audits CF deploys, sticky PR comment).

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

Smoke test asserts these tokens on the built CSS bundle (`--max: 1100px`, `--accent: #8f5520`, `noise.png` referenced, no inline SVG data URIs, no sub-12px font sizes). Update `scripts/smoke.mjs` alongside any change to the tokens it pins. Blog routes, RSS feed, and per-tag pages are also asserted (the seed post's tags drive the per-tag fixtures).

## Content

Static page copy lives in the page files under `src/pages/`. Pages in order: `/` (About + Now), `/work`, `/education`, `/urban-mobility`, `/blog`.

## Blog

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
