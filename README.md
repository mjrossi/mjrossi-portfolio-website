# mjrossi.com

Personal portfolio site. [Astro](https://astro.build) build, deployed to Cloudflare Workers with Static Assets. The site is prerendered HTML except for one on-demand route (`/contact`) that 302s to a `mailto:` so the address never appears in static output.

For the rendering model, deployment pipeline, CI, and quality gates, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Prerequisites

- [mise](https://mise.jdx.dev/) — Node version pinned in `mise.toml`

```bash
mise install   # installs Node 22
npm install
```

## Local development

```bash
npm run dev        # astro dev on http://localhost:4321
```

`astro dev` does not run the Cloudflare worker, so the `/contact` redirect is only exercised under `npm run preview` (below).

## Build and verify

```bash
npm run build      # outputs dist/client/ and dist/_worker.js
npm run smoke      # post-build assertions over dist/client/
```

The smoke test (`scripts/smoke.mjs`) checks that every route rendered, key assets exist, and the CSS bundle still carries the expected design tokens. Run it after any structural or design-token change.

## Preview and deploy

```bash
npm run preview    # build + wrangler dev (exercises /contact route)
npm run deploy     # build + wrangler deploy
```

In normal operation production deploys run automatically via Cloudflare Workers Builds on push to `main`; `npm run deploy` is for manual deploys.
