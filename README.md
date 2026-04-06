# mjrossi.com

Personal portfolio site built with [Astro](https://astro.build). Outputs static HTML — no client-side JavaScript.

## Prerequisites

- [mise](https://mise.jdx.dev/) for Node.js version management

```bash
mise install   # installs Node 22 per mise.toml
```

## Local development

```bash
npm install
npm run dev    # http://localhost:4321
```

## Build

```bash
npm run build       # outputs static files to dist/
npm run preview     # serve dist/ locally to verify before deploying
```

## Docker

```bash
docker build -t mjrossi-site .
docker run -p 8080:80 mjrossi-site
# http://localhost:8080
```

The Dockerfile uses a multi-stage build: Node 22 compiles the Astro project, then the output is served by `nginx:alpine`.
