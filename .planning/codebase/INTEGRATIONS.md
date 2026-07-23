# External Integrations

**Analysis Date:** 2026-05-17

## APIs & External Services

**Bot/spam protection:**
- Cloudflare Turnstile — CAPTCHA-alternative widget rendered on `/blog` newsletter form
  - SDK/Client: Third-party script loaded from `https://challenges.cloudflare.com/turnstile/v0/api.js` (async, deferred); configured in `src/components/NewsletterSignup.astro`
  - Token verification: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify` called server-side in `src/pages/api/subscribe.ts`
  - Auth (build-time, public): `PUBLIC_TURNSTILE_SITE_KEY` — baked into HTML via `import.meta.env`; set via mise `[env]`
  - Auth (runtime, secret): `TURNSTILE_SECRET_KEY` — Worker `env` binding; set via `wrangler secret put` in production, `.dev.vars` locally
  - Test keys: always-passes site key `1x00000000000000000000AA` used in development and CI (via `mise.development.toml` and `mise.ci.toml`)

**Email newsletter:**
- Buttondown — newsletter platform; receives subscribers and sends RSS-to-email automations
  - Subscriber endpoint: `POST https://api.buttondown.email/v1/subscribers`
  - Auth: `BUTTONDOWN_API_KEY` — Worker `env` binding; set via `wrangler secret put` in production, `.dev.vars` locally
  - Called from: `src/pages/api/subscribe.ts`
  - Default behavior: double opt-in (Buttondown sends a confirmation email before activating subscriber)
  - IP forwarding: `ip_address` is passed so Buttondown's firewall can geo/reputation-score submissions
  - Error handling: already-subscribed 400s treated as success (subscriber-enumeration defense); other 400s surface as `upstream_rejected`

**Social syndication:**
- LinkedIn — new posts auto-syndicated as standard profile posts via Buttondown Automations
  - No code in this repo; entirely operator-side configuration in Buttondown dashboard
  - Trigger: "When a newsletter is sent" → Buttondown creates a LinkedIn post automatically
  - Limitation: posts to profile only, not LinkedIn Newsletters (no API surface for that)
- Bluesky — new posts auto-syndicated via Buttondown Automations
  - No code in this repo; entirely operator-side configuration in Buttondown dashboard
  - Trigger: "When a newsletter is sent" → Buttondown creates a Bluesky post automatically

**Syndication pipeline:**
```
new MDX → git push → Cloudflare build → /blog/rss.xml → Buttondown polls RSS
                                                              ↓
                                                email + LinkedIn + Bluesky
```

**Fonts:**
- Google Fonts — Inter, Fraunces, Source Serif 4 loaded via Astro's built-in `Font` integration (`fontProviders.google()`)
  - Config: `astro.config.mjs` `fonts` array
  - All three fonts: subsets `latin`, `display: swap`, downloaded at build time and self-hosted as static assets

**Performance auditing:**
- Lighthouse CI — `treosh/lighthouse-ci-action@v12` in `.github/workflows/lighthouse.yml`
  - Audits 6 pages per deploy (/, /work, /education, /urban-mobility, /blog, /blog/why-im-pivoting)
  - Config: `.github/lighthouserc.json` (PR previews, relaxed SEO/perf thresholds) and `.github/lighthouserc.main.json` (main branch, strict)
  - Results uploaded to temporary public storage; sticky PR comment via `marocchino/sticky-pull-request-comment@v3`
  - Triggered by Cloudflare check_suite completion events

## Data Storage

**Databases:**
- None — no database
- Blog content: MDX files in `src/content/blog/` (Astro Content Collections); schema in `src/content.config.ts`
- Static page content: in `.astro` page files under `src/pages/`
- Note in `src/lib/blog.ts`: "a future D1 migration swaps only this module" — D1 is the planned migration target if a database is added

**File Storage:**
- Local filesystem only — static assets in `public/` served via Cloudflare ASSETS binding
- Key public assets: `public/og.png`, `public/noise.webp`, `public/profile-avatar.webp`, `public/resume.pdf`, `public/favicon.svg`
- Client-side JS: `public/scripts/newsletter.js` (the only client JS; served as a static asset, not bundled)

**Caching:**
- Cloudflare edge cache — HTML responses cached at the edge via `Cache-Control: public, max-age=3600` set in `src/middleware.ts`
- No application-level cache (no KV, no D1)

## Authentication & Identity

**Auth Provider:**
- None — no user accounts, no login, no sessions
- Email privacy: `GET /api/contact` (`src/pages/api/contact.ts`) redirects to `mailto:hello@mjrossi.com` so the address never appears in static HTML

## Monitoring & Observability

**Worker Observability:**
- Cloudflare Workers built-in observability enabled in `wrangler.jsonc` (`"observability": { "enabled": true }`)
- `console.error()` calls in `src/pages/api/subscribe.ts` and `src/components/NewsletterSignup.astro` surface to Worker logs

**Lighthouse auditing:**
- Automated via `.github/workflows/lighthouse.yml` on every Cloudflare deploy (see above)

**Logs:**
- No external logging service (e.g. no Sentry, no Datadog)
- Worker `console.error()` used for operator-visible errors on misconfiguration and upstream failures

## CI/CD & Deployment

**Hosting:**
- Cloudflare Workers with Static Assets binding
- Production URL: `https://mjrossi.com`
- Preview URLs: `https://<branch-alias>-mjrossi-portfolio-website-preview.link00seven.workers.dev` (per-branch, on the isolated preview Worker — `env.preview` in `wrangler.jsonc`; deployed via `wrangler versions upload --env preview`. Secrets mirror production.)

**CI Pipeline:**
- GitHub Actions — `.github/workflows/build.yml`
  - Triggers: pull requests and pushes to `main`
  - Steps: checkout → mise install (`jdx/mise-action@v4`) → export mise env → `npm ci` → `npm run build` → `npm run smoke`
  - `MISE_ENV=ci` activates `mise.ci.toml` for the always-passes Turnstile test key
- Dependabot: `.github/dependabot.yml` (present)
- Deployment: Cloudflare Workers Builds (dashboard-configured, not via Actions); build command: `mise install && mise exec -- npm run build`

## Webhooks & Callbacks

**Incoming:**
- `POST /api/subscribe` (`src/pages/api/subscribe.ts`) — newsletter signup form submission from `public/scripts/newsletter.js`
- `GET /api/contact` (`src/pages/api/contact.ts`) — email link redirect (302 to `mailto:`)

**Outgoing:**
- Turnstile verify: `POST https://challenges.cloudflare.com/turnstile/v0/siteverify`
- Buttondown subscribe: `POST https://api.buttondown.email/v1/subscribers`
- Both called with `fetchWithRetry` (3 attempts, 250ms/500ms backoff) defined in `src/lib/server.ts`

**RSS (Buttondown polls):**
- `/blog/rss.xml` — static; Buttondown polls this to trigger RSS-to-email automations

## Environment Configuration

**Required env vars (summary):**

| Variable | Where set | When needed |
|---|---|---|
| `PUBLIC_TURNSTILE_SITE_KEY` | mise `[env]` (build-time shell env) | Build time — inlined into HTML |
| `BUTTONDOWN_API_KEY` | `.dev.vars` (local) / `wrangler secret put` (prod) | Worker runtime |
| `TURNSTILE_SECRET_KEY` | `.dev.vars` (local) / `wrangler secret put` (prod) | Worker runtime |

**Secrets location:**
- Production: Cloudflare encrypted secret store (set via `wrangler secret put`)
- Local: `.dev.vars` (gitignored; template at `.dev.vars.example`)
- Build-time public key: committed in `mise.toml` (intentionally — it's public by design)

**Operator-side Buttondown config (not in repo):**
- Email template: `docs/buttondown-rss-template.md` → paste into Buttondown RSS-to-email automation Template field
- Email CSS: `docs/buttondown-email-custom.css` → paste into Buttondown Email design Custom CSS
- Web CSS: `docs/buttondown-web-custom.css` → paste into Buttondown Web design Custom CSS
- Subject line: `The Urbanist Lexicon · {{ item.title }}` (set in Buttondown dashboard, not in repo)

---

*Integration audit: 2026-05-17*
