# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

Astro (static output) + plain CSS. No client-side JavaScript.

- `src/layouts/Base.astro` — shared shell: `<html>`, nav, footer, Google Fonts
- `src/pages/*.astro` — one file per route; each uses `Base` layout
- `src/styles/global.css` — all styles; imported in `Base.astro`; uses CSS custom properties
- `public/_redirects` — Cloudflare Workers Static Assets redirect rules. `/contact` → `mailto:hello@mjrossi.com` (302) so the address never appears in the static HTML; the contact-link icon points to `/contact`. Not honored by the Docker/nginx image.
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

All copy lives in the page files under `src/pages/`. Pages in order: `/` (About + Now), `/work`, `/education`, `/urban-mobility`, `/projects`.

To add a project page later, add a file under `src/pages/projects/` or enable Astro Content Collections with `src/content/projects/` for Markdown-driven content.
