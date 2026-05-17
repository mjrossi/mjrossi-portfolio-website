# Codebase Structure

**Analysis Date:** 2026-05-17

## Directory Layout

```
mjrossi-portfolio-website/
├── src/
│   ├── assets/             # Source images processed by astro:assets at build time
│   ├── components/         # Reusable Astro UI fragments
│   │   ├── BlogPostEntry.astro
│   │   ├── ContactLinks.astro
│   │   ├── Figure.astro
│   │   ├── NewsletterSignup.astro
│   │   ├── PageHeader.astro
│   │   └── PostTags.astro
│   ├── content/
│   │   └── blog/           # MDX blog posts (flat .mdx or <slug>/index.mdx for image colocation)
│   ├── layouts/
│   │   ├── Base.astro      # Global HTML shell (masthead, nav, footer)
│   │   └── BlogPost.astro  # Post chrome; wraps Base.astro
│   ├── lib/
│   │   ├── blog.ts         # Content boundary: published posts, tags, date/reading-time helpers
│   │   ├── csp.js          # CSP string constant (plain JS; shared by middleware + gen script)
│   │   ├── edition.ts      # Masthead edition line computation
│   │   ├── readingTime.ts  # Word-count reading-time utility
│   │   └── server.ts       # API plumbing: response helpers, getEnv(), fetchWithRetry()
│   ├── pages/
│   │   ├── api/
│   │   │   ├── contact.ts  # GET → 302 to mailto:
│   │   │   └── subscribe.ts# POST newsletter subscription (Turnstile → Buttondown)
│   │   ├── blog/
│   │   │   ├── [...slug].astro     # Individual post pages
│   │   │   ├── index.astro         # Blog list + newsletter form
│   │   │   ├── rss.xml.ts          # RSS feed (prerendered)
│   │   │   └── tag/
│   │   │       └── [tag].astro     # Per-tag listing
│   │   ├── 404.astro               # 404 page (prerendered)
│   │   ├── education.astro
│   │   ├── index.astro             # Home: About + Now
│   │   ├── privacy.astro
│   │   ├── urban-mobility.astro
│   │   └── work.astro
│   ├── styles/
│   │   └── global.css      # All styles; CSS custom properties; imported once via Base.astro
│   ├── content.config.ts   # Zod schema for blog frontmatter; Astro Content Collections config
│   ├── env.d.ts            # TypeScript: Env (Worker bindings), ImportMetaEnv (PUBLIC_* vars)
│   └── middleware.ts       # Attaches CSP + Cache-Control to every HTML response
├── public/
│   ├── scripts/
│   │   └── newsletter.js   # Only client JS; served as static asset; loaded only on /blog
│   ├── _headers            # Security headers for static asset responses (ASSETS binding only)
│   ├── .assetsignore       # Keeps worker artifacts out of the ASSETS binding
│   ├── favicon.svg
│   ├── noise.webp
│   ├── og.png
│   ├── profile-avatar.webp
│   ├── robots.txt
│   └── resume.pdf
├── scripts/
│   ├── gen-headers.mjs     # Generates public/_headers from src/lib/csp.js
│   ├── make-noise.mjs      # One-off noise texture regenerator
│   ├── make-og.mjs         # One-off OG image regenerator
│   └── smoke.mjs           # Post-build smoke test (static + wrangler dev routes)
├── docs/
│   ├── ARCHITECTURE.md
│   ├── buttondown-email-custom.css   # Buttondown email Custom CSS (paste into dashboard)
│   ├── buttondown-rss-template.md    # RSS-to-email template (paste into dashboard)
│   └── buttondown-web-custom.css     # Buttondown web archive Custom CSS
├── .github/
│   └── workflows/
│       ├── build.yml       # Build + smoke test CI
│       └── lighthouse.yml  # Lighthouse audits on CF deploys
├── dist/
│   ├── client/             # Built static assets; served by Cloudflare ASSETS binding
│   └── server/             # Cloudflare Worker bundle (deployed by wrangler)
├── astro.config.mjs        # Astro config: cloudflare adapter, MDX, sitemap, fonts
├── wrangler.jsonc          # Cloudflare Worker config; ASSETS binding → dist/client
├── mise.toml               # Node 22 pin + production PUBLIC_TURNSTILE_SITE_KEY
├── mise.development.toml   # Overrides TURNSTILE_SITE_KEY with always-passes test key
├── mise.ci.toml            # Same override for CI (MISE_ENV=ci)
├── package.json
└── package-lock.json
```

## Directory Purposes

**`src/pages/`:**
- Purpose: File-based routing. One `.astro` file = one URL. API endpoints are `.ts` files.
- Contains: Page components, API route handlers
- Key files: `src/pages/index.astro` (home), `src/pages/blog/index.astro` (blog list), `src/pages/api/subscribe.ts` (newsletter backend)

**`src/layouts/`:**
- Purpose: Reusable HTML shells that wrap page content via `<slot />`
- Contains: `Base.astro` (all pages), `BlogPost.astro` (blog posts only)
- Key files: `src/layouts/Base.astro`

**`src/components/`:**
- Purpose: Presentational Astro components with scoped styles
- Contains: UI fragments used across multiple pages or layouts
- Key files: `src/components/NewsletterSignup.astro` (only client-JS carve-out)

**`src/lib/`:**
- Purpose: Pure logic, data access helpers, and shared server utilities
- Contains: TypeScript modules (and one plain JS module: `csp.js`)
- Key files: `src/lib/blog.ts` (content boundary), `src/lib/server.ts` (API plumbing)

**`src/content/blog/`:**
- Purpose: MDX source files for all blog posts
- Contains: Flat `.mdx` files or `<slug>/index.mdx` directories when colocating images
- Key files: Any `*.mdx` here is a published post; invalid frontmatter fails the build

**`src/styles/`:**
- Purpose: Global stylesheet; the only CSS entry point
- Contains: `global.css` — all CSS custom properties (design tokens), layout, component rules
- Key files: `src/styles/global.css`

**`public/`:**
- Purpose: Static assets served directly by Cloudflare ASSETS binding without Worker involvement
- Contains: Images, fonts, `newsletter.js`, `robots.txt`, `_headers`, `resume.pdf`
- Key files: `public/scripts/newsletter.js` (the only client JS), `public/_headers` (static asset security headers)

**`scripts/`:**
- Purpose: Build-time and developer utilities, not part of the deployed Worker
- Contains: `smoke.mjs` (post-build assertions), `gen-headers.mjs` (CSP header writer), one-off generators
- Key files: `scripts/smoke.mjs` (run after every build)

**`docs/`:**
- Purpose: Operator documentation and Buttondown dashboard content (source of truth; paste into dashboard)
- Contains: Architecture notes, Buttondown template/CSS files
- Generated: No — all files are hand-authored

**`dist/`:**
- Purpose: Build output; not committed to git
- Contains: `dist/client/` (static assets for ASSETS binding), `dist/server/` (Worker bundle)
- Generated: Yes — created by `npm run build`

## Key File Locations

**Entry Points:**
- `src/pages/index.astro`: Home page (About + Now)
- `src/pages/blog/index.astro`: Blog list + newsletter form
- `src/pages/api/subscribe.ts`: Newsletter subscription endpoint
- `src/pages/api/contact.ts`: Email redirect endpoint
- `src/middleware.ts`: Response header middleware (applied to all routes)

**Configuration:**
- `astro.config.mjs`: Astro adapter, integrations, font config, Vite overrides
- `wrangler.jsonc`: Cloudflare Worker name, ASSETS binding, compatibility flags
- `src/content.config.ts`: Blog frontmatter Zod schema
- `src/env.d.ts`: TypeScript types for Worker env bindings and `import.meta.env`
- `mise.toml`: Node version pin and `PUBLIC_TURNSTILE_SITE_KEY` (production value)
- `.dev.vars.example`: Template for local Worker secrets (`BUTTONDOWN_API_KEY`, `TURNSTILE_SECRET_KEY`)

**Core Logic:**
- `src/lib/blog.ts`: All content-access functions; the single import boundary for blog data
- `src/lib/server.ts`: All API response helpers and the `fetchWithRetry` utility
- `src/lib/edition.ts`: Masthead edition line (called at request time in `Base.astro`)
- `src/lib/csp.js`: CSP string constant (imported by middleware and `scripts/gen-headers.mjs`)

**Styles:**
- `src/styles/global.css`: All styles; CSS custom properties defined at `:root`; no other CSS files

**Testing:**
- `scripts/smoke.mjs`: Post-build smoke test; run via `npm run smoke` after `npm run build`

## Naming Conventions

**Files:**
- Astro components: `PascalCase.astro` (e.g., `BlogPostEntry.astro`, `NewsletterSignup.astro`)
- Astro pages: `kebab-case.astro` for static routes (e.g., `urban-mobility.astro`); bracket syntax for dynamic routes (`[...slug].astro`, `[tag].astro`)
- TypeScript library modules: `camelCase.ts` (e.g., `blog.ts`, `server.ts`, `edition.ts`, `readingTime.ts`)
- JavaScript: `camelCase.js` when plain JS is needed for cross-tool compatibility (e.g., `csp.js`)
- Scripts: `kebab-case.mjs` (e.g., `smoke.mjs`, `gen-headers.mjs`, `make-og.mjs`)
- Blog posts: `kebab-case.mdx` (e.g., `why-im-pivoting.mdx`) or `kebab-case/index.mdx` when colocating images

**Directories:**
- Source directories: lowercase (`components/`, `layouts/`, `lib/`, `pages/`, `styles/`, `content/`)
- Blog content subdirs (for image colocation): match the post slug, e.g. `how-the-netherlands-got-me-back-on-a-bike/`
- CSS classes: `kebab-case` with BEM-ish grouping (e.g., `.post-entry`, `.post-entry-title`, `.masthead-name`, `.newsletter-card`)

## Where to Add New Code

**New static page (e.g., `/speaking`):**
- Implementation: `src/pages/speaking.astro`
- Use `<Base title="Speaking">` as the layout
- Use `<PageHeader title="Speaking" />` for the page header if it fits the standard interior-page shape
- Styles: add any page-specific rules to `src/styles/global.css` under the page's section

**New blog post:**
- Flat post: `src/content/blog/my-post-slug.mdx`
- Post with colocated images: `src/content/blog/my-post-slug/index.mdx` + images alongside
- Frontmatter must pass the Zod schema in `src/content.config.ts`

**New API endpoint:**
- Implementation: `src/pages/api/<name>.ts`
- Import helpers from `src/lib/server.ts`: `getEnv`, `parseJson`, `jsonOk`, `jsonError`, `methodNotAllowed`, `fetchWithRetry`
- Return `methodNotAllowed('POST')` (or the appropriate method list) for unsupported verbs

**New reusable UI component:**
- Implementation: `src/components/MyComponent.astro`
- Scoped `<style>` block inside the component file
- Import and use in the relevant page or layout

**New shared lib utility:**
- Implementation: `src/lib/myUtil.ts`
- Use plain JS (`src/lib/myUtil.js`) only if the module must be imported by both Vite (src/) and a vanilla Node script (scripts/)

**New content data helper (blog layer):**
- Add the function to `src/lib/blog.ts`; do not call `getCollection('blog')` from any other file

## Special Directories

**`dist/`:**
- Purpose: Build output (`dist/client/` = static assets, `dist/server/` = Worker bundle)
- Generated: Yes (by `npm run build`)
- Committed: No (gitignored)

**`.astro/`:**
- Purpose: Astro's generated types and integration cache
- Generated: Yes
- Committed: No (gitignored)

**`.wrangler/`:**
- Purpose: Wrangler local state (port lock files, worker state for `wrangler dev`)
- Generated: Yes
- Committed: No (gitignored)

**`docs/`:**
- Purpose: Human-authored operator docs + Buttondown dashboard content to paste in
- Generated: No
- Committed: Yes — source of truth for email template/CSS

**`public/`:**
- Purpose: Files served verbatim by the Cloudflare ASSETS binding
- Generated: No (except `_headers`, regenerated by `scripts/gen-headers.mjs` post-build)
- Committed: Yes (images, JS, robots.txt, etc. are committed; `_headers` is generated but included)

---

*Structure analysis: 2026-05-17*
