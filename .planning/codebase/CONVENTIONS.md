# Coding Conventions

**Analysis Date:** 2026-05-17

## Naming Patterns

**Files:**
- Astro components: `PascalCase.astro` (e.g., `BlogPostEntry.astro`, `NewsletterSignup.astro`)
- TypeScript lib modules: `camelCase.ts` (e.g., `blog.ts`, `server.ts`, `edition.ts`, `readingTime.ts`)
- JavaScript lib modules (shared with Node scripts): `camelCase.js` (e.g., `csp.js` — `.js` specifically so both Vite and vanilla Node can import it without TypeScript tooling)
- API routes: `camelCase.ts` under `src/pages/api/` (e.g., `contact.ts`, `subscribe.ts`)
- Page files: `kebab-case.astro` for multi-word routes (e.g., `urban-mobility.astro`), `camelCase.astro` otherwise
- Client scripts (static assets): `camelCase.js` under `public/scripts/` (e.g., `newsletter.js`)
- Build/utility scripts: `kebab-case.mjs` (e.g., `smoke.mjs`, `gen-headers.mjs`, `make-og.mjs`)

**Functions:**
- `camelCase` for all exported and local functions
- Async functions use the `async function` declaration form for primary exports (e.g., `getPublishedPosts`, `parseJson`, `fetchWithRetry`)
- Simple one-liners use `const name = (...) => ...` arrow form (e.g., `isoDate`, `postReadingTime`)
- API route handlers: `export const GET: APIRoute`, `export const POST: APIRoute` — HTTP verb in uppercase

**Variables and Constants:**
- `camelCase` for local variables and mutable module-level values
- `SCREAMING_SNAKE_CASE` for true constants (e.g., `ROMAN_MAP`, `VOLUME_EPOCH`, `WORDS_PER_MINUTE`, `EMAIL_RX`, `MAX_EMAIL_LEN`)
- `SCREAMING_SNAKE_CASE` for script-level config constants (e.g., `DIST`, `PORT`, `BASE`, `READY_TIMEOUT_MS`)
- CSS class names: `kebab-case` throughout (e.g., `post-entry`, `masthead-name`, `newsletter-card`)
- CSS custom properties: `--kebab-case` (e.g., `--accent`, `--font-ui`, `--max`, `--pad`)

**Types:**
- `PascalCase` for exported types and interfaces (e.g., `Post`, `ParseJsonResult`, `ParseJsonOk`, `ParseJsonErr`)
- `PascalCase` for local types inside API routes (e.g., `SubscribeBody`)
- `interface Props` (not `type Props`) for Astro component prop shapes — declared in the frontmatter fenced block
- Discriminated union types via `{ ok: true; data: T }` / `{ ok: false; response: Response }` pattern

**Blog Tags:**
- Enforced `kebab-case` at schema level via Zod regex: `/^[a-z0-9]+(?:-[a-z0-9]+)*$/`
- Tags are used unescaped in URL paths and HTML attributes — the regex is the security invariant

## Code Style

**Formatting:**
- No Prettier or ESLint config files detected — formatting is applied by editor convention
- 2-space indentation throughout TypeScript and Astro files
- Single quotes for string literals in TypeScript/JavaScript
- Trailing commas in multi-line arrays and object literals
- Semicolons used consistently

**Linting:**
- No automated linter config present in the repo
- Type safety enforced by Astro's built-in TypeScript checking (via `.astro/types.d.ts` reference) and strict Zod schemas at content layer

## Import Organization

**Order (TypeScript/Astro files):**
1. Astro/framework imports (`astro:content`, `astro:middleware`, `astro:assets`, `astro/config`)
2. Cloudflare imports (`cloudflare:workers`)
3. Node built-in imports (`node:fs`, `node:path`, `node:child_process`)
4. Third-party npm packages (`@astrojs/*`, `zod`)
5. Local lib imports (relative paths, e.g., `../../lib/server`)
6. Local component imports (relative paths, e.g., `../components/BlogPostEntry.astro`)

**Path Style:**
- Always relative paths (e.g., `../../lib/server`, `../styles/global.css`)
- No path aliases (`@/` or `~`) — always explicit relative traversal
- Explicit `.ts` extensions on local TypeScript imports from `.astro` files (e.g., `import { getPublishedPosts } from '../../lib/blog.ts'`)
- No `.ts` extension when importing from `.ts` files into other `.ts` files

**Import type:**
- `import type { ... }` used consistently for type-only imports (e.g., `import type { APIRoute } from 'astro'`, `import type { ImageMetadata } from 'astro'`)

## Error Handling

**API Endpoints (server-side):**
- Discriminated result type for `parseJson`: returns `{ ok: true; data: T }` or `{ ok: false; response: Response }` — callers check `parsed.ok` before proceeding
- Early returns via `if (!parsed.ok) return parsed.response` — no nested try/catch around request parsing
- `try/catch` wraps only external network calls (Turnstile siteverify, Buttondown API) — internal logic does not use try/catch
- All errors returned via `jsonError(statusCode, 'snake_case_code')` helper — machine-readable error codes, not prose
- Missing env bindings: return `500 { error: 'turnstile_secret_missing' }` or `{ error: 'buttondown_key_missing' }` — names the specific missing binding
- 4xx errors are not retried; 5xx from upstreams use `fetchWithRetry` (3 attempts, 250ms/500ms exponential backoff)

**Pages (Astro):**
- 404 response for missing dynamic routes: `return new Response('Not Found', { status: 404 })` — in the frontmatter script block
- Missing optional config (e.g., `PUBLIC_TURNSTILE_SITE_KEY`): omit the feature and `console.error` to Worker observability rather than throw and 500 the page

**Client-side JavaScript:**
- Bucketed error messages: (A) user-fixable, (B) transient infra, (C) operator misconfig — bucket C collapses to a single fallback message with a recovery action
- `catch` block on `fetch` returns generic "Network error" — no raw error details exposed to users

## Logging

**Runtime:** `console.error` to Cloudflare Worker observability (stdout in worker context)

**Patterns:**
- Prefix log messages with the module name: `'subscribe: turnstile verify threw'`, `'subscribe: buttondown 400'`, `'NewsletterSignup: PUBLIC_TURNSTILE_SITE_KEY is not set'`
- Log on every unexpected state (missing env, upstream 4xx, thrown errors)
- Never log user-provided data that could contain PII beyond what's necessary for diagnosis
- No `console.log` in production code paths — only `console.error`

## Comments

**When to Comment:**
- Every module has a top-of-file block comment explaining its purpose and the "why" behind non-obvious design decisions
- Inline comments explain *why*, not *what*: `// Treat duplicate as success — never confirm or deny that an address is already subscribed (subscriber-enumeration defense)`
- Regression guard comments explain what failure a guard is preventing and which prior design it guards against
- Security invariants are explicitly called out: `// This regex is the security invariant that makes that safe`
- Constraints with cross-file implications are noted at the usage site: the `is:inline` workaround on `newsletter.js` in `NewsletterSignup.astro`

**JSDoc/TSDoc:**
- Not used — inline comments preferred over JSDoc decorators
- Type information lives in TypeScript signatures, not comment annotations

## Function Design

**Size:** Functions are small and single-purpose. The largest is `fetchWithRetry` at ~25 lines. `parseJson` is ~25 lines. API route handlers are the longest files but are still linear with clear early-exit structure.

**Parameters:**
- Options objects use `opts: { key?: type } = {}` pattern (e.g., `parseJson(request, { maxBytes })`, `fetchWithRetry(input, init, { retries, baseMs })`)
- Default parameters via destructuring with defaults inside the function body: `const retries = opts.retries ?? 2`

**Return Values:**
- Discriminated unions (`ParseJsonResult<T>`) for operations that can fail without throwing
- Always return typed `Response` from API route handlers — never throw from an endpoint handler
- Arrow functions for simple single-expression returns (e.g., `export const isoDate = (d: Date): string => d.toISOString().slice(0, 10)`)

## Module Design

**Exports:**
- Named exports throughout — no default exports from `.ts` lib files
- `export const`, `export function`, `export type` — all at top level, no re-export barrels
- `as const` on object literals that should be treated as immutable (`securityHeaders`)

**Barrel Files:**
- None. Each lib module is imported directly by path (e.g., `from '../../lib/server'`, `from '../../lib/blog.ts'`). No index re-export files.

**Singleton Module Values:**
- Module-level constants serve as shared singletons: `securityHeaders`, `EMAIL_RX`, `dateFormatter`, `CSP`
- No class-based singletons — plain module-level values and exported functions only

## Astro-Specific Conventions

**Component Props:**
- `interface Props { ... }` declared inside the `---` frontmatter fenced block (not exported)
- Destructured from `Astro.props` immediately after the interface declaration
- Optional props use `?` in the interface and default values in destructuring

**Pages:**
- One `.astro` file per route under `src/pages/`
- Dynamic routes: `[param].astro` or `[...slug].astro`
- `export const prerender = true` for static opt-ins; all other routes run on-demand by default
- 404 for invalid dynamic params: `return new Response('Not Found', { status: 404 })` in frontmatter

**Content Security Policy:**
- Single source of truth: `src/lib/csp.js` — imported by `src/middleware.ts` and `scripts/gen-headers.mjs`
- Written as plain `.js` (not `.ts`) so both Vite and the vanilla Node build script can import it without TypeScript tooling

**CSS:**
- All global styles in `src/styles/global.css`, imported once in `src/layouts/Base.astro`
- Component-scoped styles via `<style>` blocks inside `.astro` files — used only for `NewsletterSignup.astro`
- `:global(...)` for styles that must escape Astro's scoping (e.g., Turnstile widget wrapper, runtime-created DOM elements)
- Sections in `global.css` separated by `/* ── Section Name ──────... */` banner comments
- CSS custom properties for all design tokens — no hardcoded color values in component CSS

---

*Convention analysis: 2026-05-17*
