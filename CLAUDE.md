# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

Astro (static output) + plain CSS. No client-side JavaScript.

- `src/layouts/Base.astro` — shared shell: `<html>`, nav, footer, Google Fonts
- `src/pages/*.astro` — one file per route; each uses `Base` layout
- `src/styles/global.css` — all styles; imported in `Base.astro`; uses CSS custom properties
- `Dockerfile` — multi-stage: Node 22 builds Astro → `nginx:alpine` serves `dist/`
- `mise.toml` — pins Node 22

## Local development

```bash
mise install      # Node 22
npm install
npm run dev       # http://localhost:4321
npm run build     # outputs to dist/
npm run preview   # serve dist/ locally
```

## Docker

```bash
docker build -t mjrossi-site .
docker run -p 8080:80 mjrossi-site
```

## Design system

CSS custom properties at `:root` in `src/styles/global.css`:

- `--bg` / `--border` — dark background and dividers
- `--text` / `--muted` — primary and secondary text
- `--accent` — link color (muted blue `#5b9bd5`)

Section headers: `text-transform: uppercase` + `letter-spacing`. Experience and education entries use `.entry` / `.entry-header` / `.entry-meta` / `.company` / `.role` / `.date`.

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
