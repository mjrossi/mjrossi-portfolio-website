# Architecture

Reference for how mjrossi.com is built, deployed, and quality-checked. Read alongside `CLAUDE.md` (file map + design system) and `README.md` (commands).

## Rendering model

Astro 7 with `@astrojs/cloudflare`, configured with `output: 'server'` (`astro.config.mjs`). Every route runs on-demand in the Cloudflare Worker by default; the only route that prerenders is the one that explicitly opts in via `export const prerender = true` — currently just `/404` (Cloudflare needs a static `404.html` for the ASSETS binding to serve). `/blog/rss.xml` renders **on-demand** so that scheduled posts (a future `pubDate`) enter the feed the moment their date passes, with no rebuild — it filters through `getPublishedPosts` at request time just like the blog pages do (see "Scheduled publishing" in CLAUDE.md). The convention: **anything that doesn't render a page lives under `src/pages/api/*`** and shares the `src/lib/server.ts` helpers.

The original example was `/api/contact` (was `/contact` before the `/api/*` convention landed): it returns a 302 to `mailto:hello@mjrossi.com`, keeping the address out of the static HTML.

This shape exists because the alternatives don't fit:

- Cloudflare's `_redirects` rejects `mailto:` destinations.
- The deploy is a Cloudflare Worker with Static Assets, not classic Pages, so `functions/` isn't available.
- A static page with the address would defeat the point.

The build emits two things:

- `dist/client/` — every prerendered route plus `public/` assets. Served by Cloudflare via the `ASSETS` binding declared in `wrangler.jsonc`.
- `dist/_worker.js` — every on-demand route (HTML pages + `/api/*` endpoints). `public/.assetsignore` lists `_worker.js` and `_routes.json` so Cloudflare doesn't try to serve them as static assets.

## Layout, components, and the edition line

`src/layouts/Base.astro` is the only layout. Every page gets the full Broadsheet masthead: name, location/edition meta, italic tagline framed by rules. The name renders as an `<h1>` on `/` and as a link back to `/` on every other page (to keep the page's own `<h1>` as the sole h1).

The edition line lives in `src/lib/edition.ts` (`toRoman(n)` + `editionLine(now?)`) and `Base.astro` calls it on every render:

```
Vol. <yearOffset since 2024 in roman> · No. <month in roman> · <Month YYYY>
```

Because `output: 'server'` makes every HTML route on-demand by default, the edition line is always current. `src/middleware.ts` sets `Cache-Control: public, max-age=3600` on every HTML response (unless a route emits its own value first — e.g. Astro's prerendered 404 carries `max-age=0`), so in steady state each POP serves the cached HTML and only refreshes once an hour. The one exception: when a scheduled-post preview unlock is active (a `*.workers.dev` deploy, or a valid signed link) — or the request is for `/admin`, the Desk — middleware **overrides** the header to `no-store` and adds `X-Robots-Tag: noindex, nofollow`, so a response containing an unpublished draft is never cached at the edge or indexed. See "Previewing a scheduled post" and "The Desk" in CLAUDE.md.

`/admin` is also the one place middleware refuses a request outright: it verifies a Cloudflare Access JWT (`src/lib/access.js`) before the route runs and returns 404 on any failure, including missing configuration. The Access application is a dashboard resource producing no binding — see the account inventory below, which is its only record.

A handful of small shared components keep page templates thin:

- `src/components/ContactLinks.astro` — four contact icons (GitHub, LinkedIn, `/api/contact` for email, Bluesky) as inline SVGs that inherit `currentColor`. Rendered twice per page (nav and footer); the smoke test asserts both occurrences and that they share the `aria-label="Contact"` wrapper.
- `src/components/PageHeader.astro` — interior-page header (`<h1>` + optional description + default slot for `.page-meta` rows). Used by `/work`, `/education`, `/urban-mobility`, `/privacy`, `/blog/tags`, and `/blog/tag/[tag]`. `/blog` keeps a custom `.blog-header` because its RSS-link variant doesn't fit the prop shape; absorbing it would inflate the component more than the duplication removed.
- `src/components/PostTags.astro` — `<p class="post-tags">` chip list. `BlogPost.astro` renders it **once**, in the footer, under a `label` ("Filed under"). It used to render twice; the August 2026 review's finding 1.4 dropped the header copy, because six saturated chips between the title and the first word of prose were doing discovery work at the moment the reader wanted to start reading — and were repeated verbatim below. Up to two topics now carry that job inline in the meta line (`PostTopics.astro`).

`src/components/Subscribe.astro` owns its own scoped `<style>` block. The signup's rules used to live in `src/styles/global.css`; they were moved into the component so the dependency is explicit and `global.css` carries only chrome-and-typography. `.cf-turnstile` is wrapped in `:global()` because the Turnstile script may rewrite the wrapper attributes; `.newsletter-success` is `:global` because it's created at runtime by `public/scripts/newsletter.js` via `document.createElement` (no Astro scoping attribute).

## Newsletter and `/api/*` endpoints

`src/pages/blog/index.astro` renders `<Subscribe variant="line" />` under its header and `src/layouts/BlogPost.astro` renders `<Subscribe variant="card" />` at the foot of every **published** post (never on a draft). The form is one of only two pieces of client-side JavaScript on the site (the other is the galley review client, which loads only on a signed review link — see CLAUDE.md, "The galley"). Submission goes through `/api/subscribe`, which verifies a Cloudflare Turnstile token server-side and then forwards to Buttondown's API with `type: 'unactivated'` to trigger double opt-in. Buttondown polls `/blog/rss.xml` and sends new posts automatically — the publishing flow stays "write MDX, `git push`."

```
Reader → /blog (on-demand HTML) → fills form
       → POST /api/subscribe (on-demand Worker route)
              ├─ verify Turnstile via siteverify (server-side)
              └─ forward to Buttondown (double opt-in)
       ← 200 → "Check your inbox to confirm"
Buttondown → polls /blog/rss.xml → emails new posts
```

`src/lib/server.ts` is the single source of truth for endpoint plumbing — `securityHeaders` (`Cache-Control: no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex, nofollow`), `getEnv(locals)`, `parseJson()`, `jsonOk()`, `jsonError()`, `methodNotAllowed()`. Both `/api/contact` and `/api/subscribe` import from here; adding a third endpoint means adding to this module, not re-inlining headers.

**Secrets and env vars:**

| Variable | Where | Source (single, across all environments) |
|---|---|---|
| `PUBLIC_TURNSTILE_SITE_KEY` | Astro build (`import.meta.env`) | `mise.toml` `[env]` (committed). The real production site key is checked into the repo because it's public by design (Turnstile renders it into HTML on /blog). `mise.development.toml` and `mise.ci.toml` both override with the always-passes test key (when `MISE_ENV=development` locally or `MISE_ENV=ci` in CI). `mise.local.toml` (gitignored) can override anything for machine-specific testing. |
| `BUTTONDOWN_API_KEY` | Worker runtime (`locals.runtime.env`) | `wrangler secret put BUTTONDOWN_API_KEY` (production). `.dev.vars` (local). Not needed in CI — smoke runs sad paths only. |
| `TURNSTILE_SECRET_KEY` | Worker runtime (`locals.runtime.env`) | `wrangler secret put TURNSTILE_SECRET_KEY` (production). `.dev.vars` (local). Not needed in CI. |

**Cloudflare Workers Builds reads `mise.toml`'s `[tools]` automatically** (which is how Node 22 gets picked up). It does **not** auto-activate `[env]`. To expose `[env]` to `npm run build`, the dashboard's **Build command** must be set to `mise install && mise exec -- npm run build` (rather than the default `npm run build`). With that change, mise activates during the build and the production `PUBLIC_TURNSTILE_SITE_KEY` from `mise.toml` reaches Astro.

The split between mise and wrangler is by **layer**, not by convenience:

- **mise → shell env → build time.** mise's `[env]` table populates the shell's environment variables. Astro/Vite reads them via `process.env` / `import.meta.env` while building static HTML. This layer is for things that need to exist before the worker runs — `PUBLIC_*` vars, tool config, language version.
- **wrangler → `.dev.vars` → worker runtime.** Wrangler dev reads `.dev.vars` at startup and injects the values into the Worker's `env` binding. They never reach shell env, the browser bundle, or any other tool's `process.env`. In production the same binding is populated by `wrangler secret put` (encrypted at rest in Cloudflare's secret store) — `.dev.vars` is local-only.

No variable appears in both files; each layer reads its own source; the only thing the layers share is the Worker's `env` interface (which mise has no business writing to and wrangler has no business reading shell env for). Keeping runtime secrets out of shell env is the defense-in-depth boundary — only wrangler should see them, not every npm script in the tree. `Subscribe.astro` gracefully omits the form (with a `console.error` to Worker observability) if `PUBLIC_TURNSTILE_SITE_KEY` is missing — keeps the rest of `/blog` rendering for visitors; the endpoint returns `500 { error: 'misconfigured' }` if either runtime secret is missing.

The local files (`mise.local.toml`, `.dev.vars`) are gitignored with committed `.example` siblings. `mise.ci.toml` is itself committed because its values are publicly documented Turnstile test keys.

**CI uses `jdx/mise-action`** in `.github/workflows/build.yml`, which handles both the Node 22 install (from `mise.toml`) and the `MISE_ENV=ci` env-var export (from `mise.ci.toml`). CI doesn't need wrangler runtime secrets at all — smoke's POST assertions all exit before `getEnv()` is reached.

**Preview deploys share production runtime secrets.** Cloudflare Workers Builds deploys PR branches to per-branch URLs against the same worker, with the same `wrangler secret put` values as production. Subscriptions via a preview URL therefore land in the production Buttondown account. Acceptable for a personal site (preview URLs are `noindex`'d and traffic is tiny); `wrangler.jsonc` carries a commented scaffold showing how to isolate preview into its own environment via `[env.preview]` + `wrangler secret put --env preview` + a conditional Cloudflare Builds deploy command if the trade-off ever changes.

**CSP exception:** the Content Security Policy allows `https://challenges.cloudflare.com` for `script-src`, `connect-src`, and `frame-src` because Turnstile requires it. The allowlist is global, but the browser only fetches Turnstile where a `<script src>` exists — i.e., `/blog`. Smoke asserts the form (and its Turnstile script tag) is present on `/blog` and absent on `/` as a regression guard against accidental lifts into shared chrome.

**Where the CSP lives.** `src/middleware.ts` sets `Content-Security-Policy` on every HTML response — that's the source of truth for what browsers actually see on `/`, `/blog`, etc. `public/_headers` carries the same policy for static asset responses (CSS, fonts, images, the `/scripts/newsletter.js` helper) served by the Cloudflare ASSETS binding. We have to maintain both because Workers-with-Static-Assets routes on-demand requests through the Worker (bypassing `_headers`) and static-asset requests directly through the binding (which honors `_headers`). Smoke checks the CSP header on `/blog`'s on-demand response so the two can't silently drift.

**Why the newsletter submit handler lives in `public/scripts/`.** Astro's bundler can inline `<script>` block contents into on-demand HTML responses (variable behavior under the Cloudflare adapter), which would force us to relax `script-src` with `'unsafe-inline'` or per-page hashes. Shipping the handler as a static asset under `public/scripts/newsletter.js` sidesteps that: the asset loads via the ASSETS binding, satisfies `script-src 'self'`, and stays vanilla JS (Vite doesn't process it). `public/scripts/galley.js` — the editorial review client — ships the same way for the same reasons, and is the only other client-side JS on the site.

**Galley notes (D1).** The one stateful dependency. `mjrossi-galley` holds editorial feedback on scheduled posts, bound as `DB`; schema in `migrations/`. Posts stay in git as MDX — the database holds the conversation about a post, not the post. The write path is `src/pages/api/galley.ts`, authorised entirely by the signed preview token that middleware has already verified. There is no admin **write** endpoint, and pulling a round is still `scripts/galley-pull.mjs` over `wrangler d1 execute`, already authenticated as the operator — the pulled file is the manifest a close reads back, so it is a git operation rather than a database one. Reading across posts happens at `/admin`, the Desk, behind a Cloudflare Access JWT the worker verifies itself. See CLAUDE.md, "The galley" and "The Desk".

**Turnstile test keys** are documented at <https://developers.cloudflare.com/turnstile/troubleshooting/testing/> and pre-filled in `.dev.vars.example` / `mise.local.toml.example` for local development. CI does not need any of these — the smoke test only runs sad paths.

## Public assets and security

- `public/_headers` — applies HSTS, a strict CSP (`default-src 'none'`, no `script-src` because the site has no JS), `Cross-Origin-Opener-Policy: same-origin`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and a Permissions-Policy that disables every sensitive feature. The CSP includes `connect-src 'self'` so Lighthouse's robots.txt fetch doesn't fail (commit `3917ffa`).
- `public/.assetsignore` — keeps the worker artifacts out of the static asset binding.
- `public/robots.txt` — points at `/sitemap-index.xml`. The sitemap is generated by `@astrojs/sitemap` with a filter that excludes `/projects` (it's a `noindex` placeholder, not real content).
- `public/og.png` — 1200×630 social card. Regenerate with `node scripts/make-og.mjs public/og.png` (uses `sharp` + an inline SVG that mirrors the Broadsheet masthead, then composites the avatar and tiled noise overlay). The card intentionally has no edition line so it doesn't drift between regenerations.
- `public/noise.png` — masthead grain overlay. Regenerate with `node scripts/make-noise.mjs public/noise.png`.
- `public/favicon.svg`, `public/resume.pdf` — static assets referenced by the layout and `/work`.

## Deployment

Production deploys run automatically via Cloudflare Workers Builds connected to GitHub on push to `main`. PR branches get preview deploys at:

```
https://<branch-alias>-mjrossi-portfolio-website.link00seven.workers.dev
```

where `<branch-alias>` is the lowercased branch name with non-alphanumerics collapsed to dashes — **and then truncated** to 32 characters plus a 4-character hash (`dependabot-npm-and-yarn-npm-mino-ad6f`). Do not reconstruct this hostname by hand: a long dependabot branch slugifies to a 76-character DNS label, and the limit is 63, so the guessed name is not merely wrong but illegal and fails to resolve at all. Read the real URL out of Cloudflare's own check-run summary (`Preview Alias URL:` / `Preview URL:` lines) or the PR's deploy check. Manual deploys: `npm run deploy` (`astro build && wrangler deploy`). Local preview against the worker: `npm run preview` (`astro build && wrangler dev`) — this is the only way to exercise `/` or the `/api/*` endpoints locally; `astro dev` doesn't run the worker.

## Cloudflare account inventory

What exists in the Cloudflare account beyond what `wrangler.jsonc` declares, recorded so the next audit is a diff rather than a rediscovery. Last reconciled 2026-08-02. This repo is public, so token IDs and per-token scopes are deliberately **not** written down here — read them off the dashboard, which is the only inventory that can list tokens anyway (see the second trap below). (Resource IDs that wrangler config requires by design, such as the KV namespace `id`, do live in `wrangler.jsonc`; they are account-scoped identifiers and confer nothing without a token.)

**Only the first two rows are enforced by CI.** `smoke.mjs` compares *bindings on the deployed Worker* against `wrangler.jsonc` — that covers the Worker and its KV namespace, and nothing else. The D1 database, Turnstile widget, Access app, Web Analytics, and zones produce no binding, so no check can see them drift; this table is the only record, and it goes stale the moment someone clicks something in the dashboard. Re-reconcile it by hand.

| Resource | Detail |
|---|---|
| Workers | `mjrossi-portfolio-website` → `mjrossi.com`, `www.mjrossi.com`. `urbanist-atlas` → `urbanistatlas.com`, `www.urbanistatlas.com` (separate repo) |
| KV | one namespace, the adapter-injected `SESSION` binding — see `wrangler.jsonc` |
| D1 | `mjrossi-galley` — exists in the account, not bound by this `wrangler.jsonc` |
| Turnstile | one widget, "Portfolio site verification", scoped to the production domain and the account's workers.dev subdomain |
| Access | **two apps.** (1) the preview-URL hostname pattern above, policy "Cloudflare Workers Preview URLs" — **this, not `isPreviewHost`, is what keeps scheduled drafts on preview hosts non-public**. (2) `mjrossi.com/admin*`, guarding the Desk. Its **AUD tag and the team domain must match `vars` in `wrangler.jsonc`**, or the Desk 404s for everyone; the worker verifies the JWT itself and compares the audience, precisely so a token from app (1) — the looser policy of the two — cannot open the Desk. No Access service tokens exist — the one the Lighthouse preview audit used was deleted 2026-08-01 |
| Web Analytics | auto-install on both zones. Dashboard-only, not configured in either repo |
| Zones | `mjrossi.com`, `urbanistatlas.com` |

**No Cloudflare credential exists in CI for this repo.** It has zero GitHub Actions secrets: `build.yml` only builds and smokes, `lighthouse.yml` audits public production, and deploys run through the Workers Builds git integration, which authenticates itself. The only Cloudflare credential *we* manage is `CLOUDFLARE_API_TOKEN` in `mise.local.toml`, used by the wrangler CLI on your machine for `just deploy` and `just secret` — the Workers Builds token below exists too, but Cloudflare issues and rotates it.

### API tokens

Four exist across both repos, reconciled 2026-08-02: a **user** token for local wrangler CLI use (this repo), an **account** token supplying the sibling repo's R2 backup uploader, and the two Workers Builds credentials — one per repo — which are Cloudflare's own. **Leave the build tokens alone**; revoking one breaks deploy-on-push, and not visibly until the next push. Scopes are on the dashboard's token summary screen.

User vs account is a lifecycle decision, not a permissions one. A user token "becomes inactive if your user is removed from the account" and inherits that user's permissions, so it suits a local CLI credential that *should* die with your access. Unattended CI must not depend on a person's account membership — hence the account token for the backup uploader. Reach is controlled separately, by the resource scope.

Two traps here cost real time once each. Both are properties of Cloudflare, not of this setup:

- **"Last used" does not track R2.** R2's S3-compatible API authenticates via SigV4 against `<account>.r2.cloudflarestorage.com` and never calls the REST API v4, which is what that column reflects. A token uploading nightly backups reads as *never used*. Confirm from the audit log and the objects a token actually produces before revoking anything R2-shaped. The decisive test is running the backup workflow and checking a new dated object lands — a wrong scope 403s on `PutObject`.
- **You cannot infer a token's permissions by probing GET endpoints, and no credential here can list tokens.** Both the CLI token and the Claude MCP OAuth grant return `9109 Unauthorized` on every `/user/tokens` and `/accounts/*/tokens` route, including fetching one token by ID — so the dashboard is the only inventory. Probing is worse than useless: an empty `200` proves nothing (no queues exist, so `/queues` answers `200` regardless), several account-level reads such as Turnstile come along with `Account Settings:Read`, and `/zones` lists **every** zone in the account even when `Zone:Read` is scoped to one. GETs cannot distinguish `Read` from `Edit` either. Read the token summary screen instead.

Account-scoped audit logs cover account tokens only — user API tokens generate no `token_create` events there, so that log is not an inventory either.

## CI workflows

- `build.yml` — runs on PRs and pushes to `main`. `npm ci`, `npm test`, `npm run build`, `npm run smoke`. `npm test` runs first: it is the only gate over the preview-token HMAC and the scheduled-publishing predicate, which smoke cannot verify.
- `lighthouse.yml` — audits **production only**, firing on `check_suite` completion when the Cloudflare Workers Builds check succeeds on `main` (plus `workflow_dispatch`, which takes no input — the target is always mjrossi.com). Audits six routes (`/`, `/work`, `/education`, `/urban-mobility`, `/blog`, and one post — `/blog/why-im-pivoting`). `/projects` is excluded because it's `noindex` and would fail SEO by design. The blog pair is what covers the newsletter form's Turnstile script and the `BlogPost` layout; keep the list here in sync with the `urls:` block in `.github/workflows/lighthouse.yml`. One config, `.github/lighthouserc.json` — all four categories enforce as `error` (perf/SEO at minScore 0.9, a11y/best-practices at 1.0). Reports go to `temporaryPublicStorage` and a run artifact; there is no PR comment and no custom check run.
  - **Why not audit PR preview deploys?** It was tried, at length, and it isn't worth what it costs. Preview hosts sit behind Cloudflare Access, so the audit needs a `CF_ACCESS_*` service token — and Lighthouse copies `settings.extraHeaders` verbatim into `configSettings` in every report JSON and inlines that JSON into every HTML report. On a public repo, that one requirement drags in a redaction pass over the report directory, gating on both of the action's upload paths, a fork-PR refusal (a Worker built from a fork can read the token off the request), and a host allowlist anchored on the account subdomain so a free-text dispatch URL can't be handed the credentials. That was ~350 lines of security-critical shell in service of a preview audit that never once produced a valid score — before the token it was scoring the Access login page (a flat A11y 77 / BP 93 / SEO 54), and before that it was pointed at a hostname that didn't resolve. Production has no token, so none of it is needed. The trade is post-merge rather than pre-merge detection, which on a static site with instant deploys and revert-as-rollback is the cheaper failure.
  - **`numberOfRuns` is 3, and this is not tuning.** At one run a noisy shared runner is enough to fail the build on its own: with identical content, `/` has scored 97, 97, 65, 72, 97 across consecutive runs, the low samples showing >1s of TBT on a page that ships no client JS. Three samples make a single bad one harmless. The config also pins **`aggregationMethod: "median"`**, which is *not* the LHCI default — the default is `optimistic` (best of N), which would let a single good sample mask two bad ones.

    Use `"median"` and not `"median-run"`, which looks like the more precise setting and is a **no-op here**. `median-run` swaps in the median LHRs only on the audit-assertion path; a `categories:*` assertion — which is all this config asserts — goes through `getCategoryAssertionResults()`, is handed the full LHR set, and falls through to `Math.max(...)`, i.e. exactly the `optimistic` default. Measured against `@lhci/utils` 0.15.1 with runs scoring .87/.84/.72, `median-run` and `optimistic` both assert **0.87** while `median` asserts **0.84**.

    If perf starts going red on `main` without a code change, the observed TBT variance above is the likely cause and the honest fix is to drop `categories:performance` to `warn` — not to switch aggregation to `optimistic`, which hides two bad runs in three.
  - Known non-failure: every page scores SEO 92, not 100, because Cloudflare's managed AI Crawl Control prepends a `Content-Signal:` directive to `/robots.txt` at the edge that Lighthouse doesn't recognise. It is not in `public/robots.txt` and is not fixable in this repo; 92 clears the 0.9 gate.
- `dependabot.yml` — weekly npm and github-actions updates, minor and patch grouped (`npm-minor-patch`, `actions-minor-patch`).

## Smoke tests

Two layers. `npm test` runs `node --test` over `src/**/*.test.js`. Beyond the galley's own suites, the load-bearing ones are: `src/lib/access.test.js`, over the Cloudflare Access JWT gate on `/admin` (round trip, a valid token for **another application on the same team**, `alg: none`, HMAC confusion against the published RSA public key, expiry, unset config); `src/lib/sql-literal.test.js`, over the one place a value is rendered into SQL text from the CLI; and `src/lib/link-state.test.js`, over the four words the roster and the Desk both answer "what is outstanding?" with. `src/lib/schedule.test.js` covers the scheduled-publishing date predicate (past/future/exact-midnight-UTC boundary), and `src/lib/preview.test.js` covers the two preview unlocks — the `*.workers.dev` host allowlist (including lookalike domains like `evil-workers.dev` and, critically, the Worker's **own production alias**, neither of which may match) and the signed-link HMAC (round trip, expiry boundary, wrong key, tampered slug, tampered expiry, malformed input, and an unset key rejecting everything). Both exist because the logic is time- and crypto-dependent and cannot be meaningfully exercised by an acceptance check against a corpus of already-published posts.

The scheduled-post surfaces are the exception to "smoke can't test this": `src/content/blog/smoke-scheduled-fixture.mdx` is a permanently future-dated fixture that gives smoke something real to try to leak, so it can assert the signed-link scoping over HTTP in both directions. See CLAUDE.md → "Previewing a scheduled post".

Everything else is one post-build acceptance check: `scripts/smoke.mjs` (`npm run smoke`). No test framework — each assertion targets a regression that would be user-visible, not every class name in the markup.

First it inspects `dist/client/` for static artifacts: the expected assets (`noise.webp`, `profile-avatar.webp`, `favicon.svg`, `resume.pdf`, `og.png`, `404.html`, `sitemap-index.xml`) exist, the per-post OG cards under `og/` exist for a published post and — the other direction — do **not** exist for the scheduled fixture, whose title would otherwise be readable at a slug-derived URL, and the built CSS bundle still pins `--accent: #8f5520`, `--max: 1100px`, has no inline `data:image/svg+xml` URIs, and has no leftover condensed-masthead rules. It also greps source files for wiring that would fail silently if removed: `fetchWithRetry` in `src/lib/server.ts`, the `isPublished` call in `src/lib/blog.ts` (the unit tests prove that predicate correct but would stay green if `getPublishedPosts` stopped calling it), and the preview-unlock wiring in both directions — that `src/pages/blog/[...slug].astro` still reads `previewSlug`, and that `previewSlug` has **not** leaked into `src/lib/blog.ts` or the RSS route, which would let a shared preview link inject an unpublished post into the feed that drives Buttondown's subscriber email. These source greps strip comments first, so prose *explaining* that an identifier is deliberately absent can't trip the check asserting its absence.

Then it spins up `wrangler dev` once and fetches every on-demand route (`/`, `/work`, `/education`, `/urban-mobility`, `/blog`, one blog post chosen from the index, one tag page chosen from the index, `/blog/rss.xml`). The top-level GETs and the blog chain run in parallel — the wall-time savings are meaningful and `fetchExpectingNon5xx` already retries once on transient workerd 5xx. For every HTML route it asserts: 200 OK, `Cache-Control: public, max-age=3600` (set by `src/middleware.ts`, not per page), the full Broadsheet masthead rendered, the edition line matches `Vol. X · No. Y · Month YYYY`, no condensed-masthead residue, `ContactLinks` rendered twice (nav + footer), and the nav pill marked `active` on the correct link.

For `/blog/rss.xml` it additionally asserts `Cache-Control: max-age=3600` (the route sets this itself — middleware only defaults Cache-Control on HTML), that `X-Content-Type-Options: nosniff` and `Strict-Transport-Security` are present (the feed went on-demand for scheduled publishing, so it no longer inherits `_headers` from the ASSETS binding and depends on middleware applying the security set to non-HTML responses), that every `<pubDate>` parses, and that none is in the future.

The `/api/subscribe` sad paths are driven by a `subscribeCases` table (status-only assertions for the contract) and fanned out via `Promise.all`. Two assertions stay outside the table — the realistic-2.5KB-token payload guard (inequality, longer message) and the privacy-page content checks — but they fetch in parallel too.

If you change a CSS token, a route's chrome, or the navigation contract, expect to update the corresponding assertion in `scripts/smoke.mjs`.

## One-off generators

- `scripts/make-noise.mjs` — regenerates `public/noise.png` from an SVG `feTurbulence` filter via `sharp`. Run when changing the masthead grain look.
- `scripts/make-og.mjs` — regenerates `public/og.png` (1200×630). Mirrors the live masthead at OG dimensions: amber band with tiled noise overlay, Fraunces-style serif name with accented surname, italic tagline framed by rules, editorial pull quote, Broadsheet footer. Falls back to Georgia/system-ui because the site fonts aren't installed in Node — close enough at OG sizes. Intentionally omits the edition line so the card stays timeless.

## Things to know when changing the design

- The design tokens live in one place (`:root` in `src/styles/global.css`). Touch them and the smoke test will likely complain — update `scripts/smoke.mjs` in the same change.
- The masthead is a single variant that renders everywhere. The name is an `<h1>` on `/` and a link to `/` on subpages.
- Output mode is `server`, so new HTML routes are on-demand by default — no `prerender` export needed. The only route that opts back into prerender is `/404` (Cloudflare needs a static `404.html`). `src/middleware.ts` sets `Cache-Control: public, max-age=3600` on every HTML response, so individual pages don't need to. New routes still need a smoke assertion in `scripts/smoke.mjs`.
- Anything that needs to stay current without a rebuild belongs on a non-prerendered route (the default) and inherits the middleware cache header. `/blog/rss.xml` is on-demand for exactly this reason — scheduled posts must be able to enter the feed without a redeploy — and because it isn't HTML it sets its own `Cache-Control` (middleware only touches `text/html`).
- Interior pages reuse `src/components/PageHeader.astro` for the `.page-header` shape. If a new page needs a different header (e.g. embedded RSS link like `/blog`), use a bespoke header rather than inflating `PageHeader`'s prop surface.
