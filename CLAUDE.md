# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Stack

Plain HTML + CSS. No build tooling, no framework, no JavaScript.

- `index.html` — single page, all content
- `style.css` — all styles, uses CSS custom properties for the design system
- `Dockerfile` — `nginx:alpine` serving static files; no build step required

## Local preview

Open `index.html` directly in a browser. No server needed.

## Docker

```bash
docker build -t mjrossi-site .
docker run -p 8080:80 mjrossi-site
# visit http://localhost:8080
```

## Design system

CSS custom properties defined at `:root` in `style.css`:

- `--bg` / `--border` — dark background and dividers
- `--text` / `--muted` — primary and secondary text
- `--accent` — link color (muted blue `#5b9bd5`)

Section headers use `text-transform: uppercase` + `letter-spacing`. Experience and education entries share the `.entry` / `.entry-header` / `.company` / `.role` / `.date` pattern.

## Content

All copy is in `index.html`. Sections in order: About, Now, Urban Mobility, Experience, Education. Contact links appear in the `<header>` and `<footer>`.
