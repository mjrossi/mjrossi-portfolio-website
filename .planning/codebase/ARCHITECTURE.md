<!-- refreshed: 2026-05-17 -->
# Architecture

**Analysis Date:** 2026-05-17

## System Overview

```text
┌─────────────────────────────────────────────────────────────────────┐
│                    Browser / Edge Client                             │
└──────────────────────────────┬──────────────────────────────────────┘
                               │ HTTP request
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│           Cloudflare Workers (on-demand rendering)                   │
│                                                                      │
│  ┌──────────────────┐   ┌──────────────────┐   ┌─────────────────┐  │
│  │  src/middleware  │   │  src/pages/*.astro│   │ src/pages/api/* │  │
│  │ (CSP + Cache-    │   │  (HTML routes)    │   │ (JSON / redirect│  │
│  │  Control headers)│   │                  │   │  endpoints)     │  │
│  └──────────┬───────┘   └────────┬─────────┘   └────────┬────────┘  │
│             │ wraps every resp   │                       │           │
│             └────────────────────┼───────────────────────┘           │
│                                  │                                   │
│          ┌───────────────────────▼────────────────────────┐         │
│          │              src/layouts/                       │         │
│          │  Base.astro (masthead, nav, footer shell)       │         │
│          │  BlogPost.astro (post chrome)                   │         │
│          └───────────────────────┬────────────────────────┘         │
│                                  │                                   │
│          ┌───────────────────────▼────────────────────────┐         │
│          │              src/components/                    │         │
│          │  BlogPostEntry, ContactLinks, Figure,           │         │
│          │  NewsletterSignup, PageHeader, PostTags         │         │
│          └───────────────────────┬────────────────────────┘         │
│                                  │                                   │
│          ┌───────────────────────▼────────────────────────┐         │
│          │                src/lib/                         │         │
│          │  blog.ts (content boundary)                     │         │
│          │  server.ts (API plumbing)                       │         │
│          │  edition.ts (masthead date line)                │         │
│          │  csp.js (Content Security Policy)               │         │
│          │  readingTime.ts (utility)                       │         │
│          └───────────────────────┬────────────────────────┘         │
│                                  │                                   │
│          ┌───────────────────────▼────────────────────────┐         │
│          │          Content & Static Assets                │         │
│          │  src/content/blog/*.mdx  (MDX posts)            │         │
│          │  public/                 (static assets)         │         │
│          │  dist/client/            (built assets / ASSETS) │         │
│          └────────────────────────────────────────────────┘         │
└─────────────────────────────────────────────────────────────────────┘
         │                               │
         ▼ Turnstile verify              ▼ Buttondown API
  challenges.cloudflare.com       api.buttondown.email
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Middleware | Sets CSP and default `Cache-Control: public, max-age=3600` on every HTML response | `src/middleware.ts` |
| Base layout | Shared HTML shell: masthead, nav, footer, OG meta, font loading | `src/layouts/Base.astro` |
| BlogPost layout | Post-specific chrome: title, byline, tags, optional cover, back link | `src/layouts/BlogPost.astro` |
| BlogPostEntry | Shared article card used on list and tag pages | `src/components/BlogPostEntry.astro` |
| ContactLinks | Inline-SVG icon row (GitHub, LinkedIn, email, Bluesky); rendered twice per page (nav + footer) | `src/components/ContactLinks.astro` |
| Figure | Optional `<figure>` wrapper with caption for MDX posts | `src/components/Figure.astro` |
| NewsletterSignup | Email form with Turnstile; the only carve-out from the no-client-JS rule; rendered only on `/blog` | `src/components/NewsletterSignup.astro` |
| PageHeader | Shared interior-page `<h1>` + description + slot for `.page-meta` | `src/components/PageHeader.astro` |
| PostTags | `<p class="post-tags">` chip list; rendered in header and footer of BlogPost | `src/components/PostTags.astro` |
| blog.ts | Content boundary: `getPublishedPosts`, `getAllTags`, `getPostsByTag`, date/reading-time helpers | `src/lib/blog.ts` |
| server.ts | API plumbing: `securityHeaders`, `getEnv()`, `parseJson()`, `jsonOk()`, `jsonError()`, `methodNotAllowed()`, `fetchWithRetry()` | `src/lib/server.ts` |
| edition.ts | `toRoman(n)` + `editionLine(now?)` for the masthead date line | `src/lib/edition.ts` |
| csp.js | Single CSP string constant shared by middleware and static asset header generator | `src/lib/csp.js` |
| readingTime.ts | Word-count reading-time estimate | `src/lib/readingTime.ts` |
| content.config.ts | Zod schema for blog post frontmatter; single source of truth | `src/content.config.ts` |

## Pattern Overview

**Overall:** On-demand server-side rendering via Cloudflare Workers, with MDX content collections as the data source. No client-side framework; no database at runtime.

**Key Characteristics:**
- Every HTML route runs as a Cloudflare Worker on-demand by default (`output: 'server'`); only `/404` and `/blog/rss.xml` opt into static with `export const prerender = true`
- One-hour edge cache (`Cache-Control: public, max-age=3600`) set by middleware on all HTML responses; the edge absorbs traffic while the dynamic edition line refreshes hourly
- Zero client-side JavaScript except the newsletter form on `/blog` (`public/scripts/newsletter.js`), served as a static asset to satisfy the strict `script-src 'self'` CSP without `'unsafe-inline'`
- Content is MDX files committed to the repo; publish = `git push`; no CMS or database

## Layers

**Routing layer:**
- Purpose: Map URL paths to Astro page components
- Location: `src/pages/`
- Contains: `.astro` page files, API endpoint `.ts` files
- Depends on: layouts, lib
- Used by: Astro router (Cloudflare Worker entrypoint)

**Middleware layer:**
- Purpose: Attach security and cache headers to every HTML response after the page handler runs
- Location: `src/middleware.ts`
- Contains: `onRequest` handler; imports CSP from `src/lib/csp.js`
- Depends on: `src/lib/csp.js`
- Used by: Astro middleware chain (applied automatically to all routes)

**Layout layer:**
- Purpose: Provide reusable HTML shells that wrap page content
- Location: `src/layouts/`
- Contains: `Base.astro` (global shell), `BlogPost.astro` (post chrome)
- Depends on: components, lib
- Used by: pages

**Component layer:**
- Purpose: Reusable UI fragments with scoped styles
- Location: `src/components/`
- Contains: presentational Astro components; `NewsletterSignup.astro` is the only one with JS behaviour
- Depends on: lib (for data helpers)
- Used by: layouts, pages

**Library layer:**
- Purpose: Pure logic, data access, and shared server utilities
- Location: `src/lib/`
- Contains: `blog.ts`, `server.ts`, `edition.ts`, `csp.js`, `readingTime.ts`
- Depends on: `astro:content` (blog.ts), `cloudflare:workers` (server.ts)
- Used by: pages, layouts, components, middleware

**Content layer:**
- Purpose: Source of truth for blog post data
- Location: `src/content/blog/`
- Contains: `.mdx` files (flat or colocated in `<slug>/index.mdx` for image colocation)
- Depends on: nothing (consumed by `blog.ts` via `astro:content`)
- Used by: `src/lib/blog.ts`

**API layer:**
- Purpose: Non-page endpoints (JSON responses, redirects)
- Location: `src/pages/api/`
- Contains: `contact.ts` (302 to `mailto:`), `subscribe.ts` (newsletter subscription)
- Depends on: `src/lib/server.ts`
- Used by: browser (client-side fetch from newsletter form), contact link in `ContactLinks.astro`

## Data Flow

### Standard Page Request

1. Request hits Cloudflare Worker — Astro router dispatches to the matching `src/pages/*.astro` file
2. Page component's frontmatter runs server-side: may call `getPublishedPosts()` or similar from `src/lib/blog.ts`
3. `blog.ts` calls `getCollection('blog')` from `astro:content`, which reads MDX files from `src/content/blog/`
4. Page renders through its layout (`Base.astro` or `BlogPost.astro → Base.astro`), assembling components
5. `Base.astro` calls `editionLine()` from `src/lib/edition.ts` to compute the current masthead date string at request time
6. Astro returns the HTML response; `src/middleware.ts` appends `Content-Security-Policy` and `Cache-Control: public, max-age=3600`
7. Cloudflare edge caches the response for up to one hour

### Newsletter Subscription Flow

1. User fills the form in `src/components/NewsletterSignup.astro` on `/blog`
2. `public/scripts/newsletter.js` (static asset, no bundler) intercepts submit, reads the Turnstile token via `window.turnstile.getResponse()`
3. JS `fetch`es `POST /api/subscribe` with `{ email, turnstileToken, company }` (honeypot)
4. `src/pages/api/subscribe.ts` validates the body via `parseJson()` from `src/lib/server.ts`
5. Endpoint calls Cloudflare Turnstile `siteverify` via `fetchWithRetry` (up to 3 attempts with exponential backoff)
6. On success, endpoint calls Buttondown `POST /v1/subscribers` via `fetchWithRetry`; passes `ip_address` for geo/reputation scoring
7. Buttondown response is normalised: 201/200 → success; already-subscribed 400 → silent success (subscriber-enumeration defense); other 400 → `upstream_rejected`; 429 → `rate_limited`
8. Endpoint returns `jsonOk()` or `jsonError()` from `src/lib/server.ts`; JS updates the form UI

### RSS / Blog Discovery Flow

1. `GET /blog/rss.xml` renders **on demand** (not prerendered): `src/pages/blog/rss.xml.ts` calls `getPublishedPosts()` per request, so a scheduled post enters the feed once its `pubDate` passes with no rebuild
2. Buttondown polls `/blog/rss.xml`; on new items it sends **email only**
3. Social syndication (LinkedIn, Bluesky, Facebook) is **manual** — Buttondown's social automations need a higher plan tier and are not active. No code in this repo owns syndication; see CLAUDE.md § "Syndication (social)"

**State Management:**
- No client state beyond the newsletter form (ephemeral: cleared on success/reload)
- No server-side session or database; all content is in MDX files
- Worker runtime secrets (`BUTTONDOWN_API_KEY`, `TURNSTILE_SECRET_KEY`) accessed via `import { env } from 'cloudflare:workers'` through the `getEnv()` wrapper in `src/lib/server.ts`

## Key Abstractions

**Content boundary (`blog.ts`):**
- Purpose: Decouple rendering from content source; a future D1 migration swaps only this module
- Examples: `src/lib/blog.ts`
- Pattern: All pages import `getPublishedPosts`, `getAllTags`, `getPostsByTag` from this single module; nothing else imports from `astro:content` directly

**API plumbing (`server.ts`):**
- Purpose: Shared response helpers so all `/api/*` endpoints share consistent headers, error codes, and JSON shape
- Examples: `src/lib/server.ts`
- Pattern: Every endpoint imports `{ securityHeaders, getEnv, parseJson, jsonOk, jsonError, methodNotAllowed, fetchWithRetry }` from this module

**Edition line (`edition.ts`):**
- Purpose: Compute the masthead "Vol. X · No. Y · Month YYYY" string from the current date
- Examples: `src/lib/edition.ts`
- Pattern: Imported by `Base.astro` only; called on every on-demand render so no rebuild is needed to keep the line current

**CSP constant (`csp.js`):**
- Purpose: Single source of truth for the Content Security Policy string shared between `src/middleware.ts` and `scripts/gen-headers.mjs`
- Examples: `src/lib/csp.js`
- Pattern: Plain JS (not TS) so both Vite (src/) and a vanilla Node script (scripts/) can import it without TypeScript tooling

## Entry Points

**HTML pages:**
- Location: `src/pages/*.astro`, `src/pages/blog/*.astro`, `src/pages/blog/tag/[tag].astro`
- Triggers: HTTP GET requests from browser / edge cache miss
- Responsibilities: Fetch data, render layout + components, return HTML

**API endpoints:**
- Location: `src/pages/api/contact.ts`, `src/pages/api/subscribe.ts`
- Triggers: HTTP GET (`contact`) or POST (`subscribe`) from browser
- Responsibilities: Validate, call upstream services, return JSON or redirect

**Middleware:**
- Location: `src/middleware.ts`
- Triggers: Automatically wraps every Astro response
- Responsibilities: Attach CSP header; set default `Cache-Control: public, max-age=3600` if not already set

**Cloudflare Worker entrypoint:**
- Location: Built into `dist/server/` by `@astrojs/cloudflare`; wrangler config in `wrangler.jsonc`
- Triggers: Every request to the Worker
- Responsibilities: Route to Astro handler or serve static assets via the `ASSETS` binding (`dist/client/`)

## Architectural Constraints

- **Threading:** Single-threaded Cloudflare Worker event loop; no shared mutable state across requests
- **Global state:** None intentionally; `editionLine()` and `getEnv()` are stateless function calls. Content collections are loaded per-request via `astro:content`
- **Circular imports:** None detected; the dependency graph is acyclic (pages → layouts → components → lib → astro:content / cloudflare:workers)
- **Client JS isolation:** `public/scripts/newsletter.js` must never be imported outside `src/components/NewsletterSignup.astro`; `NewsletterSignup.astro` must never be lifted into `Base.astro` or any shared chrome. Smoke tests assert both invariants
- **Prerender exceptions:** Only `src/pages/404.astro` and `src/pages/blog/rss.xml.ts` declare `export const prerender = true`; all other routes are on-demand
- **Secret access:** Worker runtime secrets are accessed exclusively via `getEnv()` in `src/lib/server.ts` using `import { env } from 'cloudflare:workers'`. Build-time public vars are accessed via `import.meta.env.PUBLIC_*`

## Anti-Patterns

### Importing astro:content outside blog.ts

**What happens:** A page or component calls `getCollection('blog')` directly rather than going through `src/lib/blog.ts`.
**Why it's wrong:** Bypasses the single content boundary; a future migration (e.g. to D1) would require touching every call site instead of swapping one module.
**Do this instead:** Import `getPublishedPosts`, `getAllTags`, or `getPostsByTag` from `src/lib/blog.ts`.

### Using Astro.locals.runtime.env for secrets

**What happens:** An endpoint accesses the Cloudflare env via `Astro.locals.runtime.env` (the pre-Astro v6 pattern).
**Why it's wrong:** `@astrojs/cloudflare` 13+ removed this; the adapter now throws an explicit migration error on the old path.
**Do this instead:** Call `getEnv()` from `src/lib/server.ts`, which wraps `import { env } from 'cloudflare:workers'`.

### Lifting NewsletterSignup into shared chrome

**What happens:** `NewsletterSignup.astro` is imported in `Base.astro` or `BlogPost.astro`.
**Why it's wrong:** Adds client-side JS (Turnstile loader + submit handler) to every page; breaks the no-client-JS contract; smoke tests will fail asserting the form is absent on `/`.
**Do this instead:** Keep `NewsletterSignup.astro` imported only in `src/pages/blog/index.astro`.

### Using public/_headers for on-demand HTML headers

**What happens:** A security or cache header is added to `public/_headers` expecting it to apply to HTML page responses.
**Why it's wrong:** `public/_headers` only applies to static asset responses served by the Cloudflare ASSETS binding; on-demand HTML pages bypass that file entirely.
**Do this instead:** Set headers in `src/middleware.ts` (HTML pages) or update `src/lib/csp.js` and regenerate `_headers` for static assets.

## Error Handling

**Strategy:** Fail fast with typed error codes; surface to operator via Worker logs; degrade gracefully toward the user.

**Patterns:**
- API endpoints return `jsonError(status, 'snake_case_code')` from `src/lib/server.ts`; the client maps known codes to user messages and collapses unknown codes to a manual-fallback message
- Missing runtime secrets (`TURNSTILE_SECRET_KEY`, `BUTTONDOWN_API_KEY`) → `500` with named error code so the operator can fix without reading logs
- Already-subscribed Buttondown 400 → silent `200` (subscriber-enumeration defense)
- `fetchWithRetry` retries transient 5xx and network errors up to 3 attempts with 250ms exponential backoff; deterministic 4xx errors are not retried
- `NewsletterSignup.astro`: missing `PUBLIC_TURNSTILE_SITE_KEY` at request time logs a `console.error` to Worker observability and omits the form rather than 500ing the whole `/blog` page

## Cross-Cutting Concerns

**Logging:** `console.error` to Cloudflare Worker observability (enabled via `wrangler.jsonc` `observability.enabled: true`); no structured logging library
**Validation:** Zod at build time for MDX frontmatter (`src/content.config.ts`); manual type guards + `parseJson()` at runtime for API request bodies
**Authentication:** None for site visitors; API secrets are runtime Worker bindings accessed only server-side

---

*Architecture analysis: 2026-05-17*
