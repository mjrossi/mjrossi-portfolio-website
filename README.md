# mjrossi.com

Personal portfolio site. [Astro](https://astro.build) build, deployed to Cloudflare Workers with Static Assets. The site is prerendered HTML except for a handful of on-demand routes under `src/pages/api/*` (`/api/contact` 302s to a `mailto:` so the address never appears in static output; `/api/subscribe` relays newsletter signups to Buttondown after a Turnstile check).

For the rendering model, deployment pipeline, CI, and quality gates, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Prerequisites

- [mise](https://mise.jdx.dev/) — Node 22 is pinned in `mise.toml`

```bash
mise install   # installs Node 22
npm install
```

## Local development

For pure content work (writing blog posts, adjusting copy), `astro dev` is enough — it doesn't run the Cloudflare worker but it serves every prerendered page instantly:

```bash
npm run dev        # astro dev on http://localhost:4321
```

The newsletter signup form on `/blog` needs the Cloudflare worker (for `/api/subscribe`) and a Turnstile site key (for the widget). To exercise it end to end:

1. **Copy the env templates** (both are gitignored):

   ```bash
   cp mise.local.toml.example mise.local.toml   # build-time vars
   cp .dev.vars.example .dev.vars               # worker-runtime secrets
   ```

   The defaults give you a working form except for the actual Buttondown call — that returns 502 to the client because the placeholder API key isn't real. Replace `BUTTONDOWN_API_KEY` in `.dev.vars` with a real free-tier key from <https://buttondown.com> if you want the full happy path.

2. **Run the worker locally**:

   ```bash
   npm run preview    # build + wrangler dev (exercises every on-demand route)
   ```

   This is the only way to hit `/api/contact`, `/api/subscribe`, or to see Turnstile render. `astro dev` skips the worker entirely.

### How env vars flow

Two files, two layers. Each variable lives in exactly one place:

| Variable | File | Read by | When |
|---|---|---|---|
| `PUBLIC_TURNSTILE_SITE_KEY` | `mise.toml` `[env]` (committed) — real production site key, public by design | Astro / Vite (`import.meta.env`) | build time (inlined into HTML) |
| `BUTTONDOWN_API_KEY` | `.dev.vars` | Wrangler → Worker (`locals.runtime.env`) | runtime |
| `TURNSTILE_SECRET_KEY` | `.dev.vars` | Wrangler → Worker (`locals.runtime.env`) | runtime |

mise owns shell env (build-time tools, language version, and the public Turnstile site key). Wrangler owns worker bindings (runtime secrets). Keeping the worker secrets out of shell env means only wrangler can see them — a small but real defense-in-depth boundary. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture and [CLAUDE.md](CLAUDE.md) for the "how mise and wrangler relate" explanation.

mise picks files in this precedence order: `mise.local.toml` (gitignored, optional) > `mise.<MISE_ENV>.toml` (committed; e.g. `mise.development.toml`, `mise.ci.toml`) > `mise.toml`. The recommended local shell setting is `MISE_ENV=development` (in your `~/.zshrc` / `~/.bashrc`), which auto-substitutes the always-passes Turnstile test key locally — no need to add `localhost` to your real Turnstile site's hostname allowlist. CI does the same with `MISE_ENV=ci`, set in `.github/workflows/build.yml`.

## Build and verify

```bash
npm run build      # outputs dist/client/ and dist/_worker.js
npm run smoke      # post-build assertions over dist/client/
```

The smoke test (`scripts/smoke.mjs`) checks that every route rendered, key assets exist, the CSS bundle still carries the expected design tokens, and `/api/subscribe` rejects malformed input. Run it after any structural or design-token change.

If `PUBLIC_TURNSTILE_SITE_KEY` is missing at build time, `/blog` will render *without* the newsletter form and log the misconfiguration to Worker observability via `console.error`. The rest of the blog renders normally — visitors don't see a 500, but you'll notice the form is missing and find the log line.

## Preview and deploy

```bash
npm run preview    # build + wrangler dev (run on every on-demand route)
npm run deploy     # build + wrangler deploy (manual)
```

In normal operation production deploys run automatically via Cloudflare Workers Builds on push to `main` (`wrangler deploy` → the production Worker). PR branches deploy to an **isolated preview Worker** (`env.preview` in `wrangler.jsonc` → `mjrossi-portfolio-website-preview`), so branch code never lands on production. Preview URLs are `<branch>-mjrossi-portfolio-website-preview.link00seven.workers.dev`. This isolation exists because a dashboard secret edit redeploys the Worker's latest uploaded version — before the split, editing a secret mid-feature promoted branch code to `mjrossi.com`.

Note the selection mechanism is **build-time**, not deploy-time: under `@astrojs/cloudflare` v14 the adapter regenerates the wrangler config and strips the `env` block, so the environment is chosen by the `CLOUDFLARE_ENV` variable during `astro build`. In Workers Builds that means a branch-conditional **build command** (`… if [ "$WORKERS_CI_BRANCH" = "main" ]; then npm run build; else CLOUDFLARE_ENV=preview npm run build; fi`), a production deploy command of `npx wrangler deploy`, and a non-production deploy command of a plain `npx wrangler versions upload` (no `--env`). See `wrangler.jsonc` and `CLAUDE.md` for the full rationale.

**Preview secrets mirror production.** They're set with `wrangler secret put X --env preview` using the same values as production, so a subscription submitted via a preview URL still goes to the production Buttondown account. For a personal portfolio this is acceptable (preview URLs are `noindex`'d, traffic is low); give the preview env a separate Buttondown key to isolate that too.

## Newsletter setup (one-time)

Before the form works in production, four out-of-band steps:

1. **Turnstile site**: Cloudflare → Turnstile → add site `mjrossi.com` (add `link00seven.workers.dev` to Hostname management if you want preview URLs to render the widget too). Put the **Site key** in two places — keep them the same value: `mise.toml`'s `[env]` block (local dev + GitHub CI) and the Cloudflare `PUBLIC_TURNSTILE_SITE_KEY` build variable (production, step 2). `wrangler secret put TURNSTILE_SECRET_KEY` for the secret half.
2. **Cloudflare build variables**: Workers & Pages → `mjrossi-portfolio-website` → Settings → Build → Variables and secrets → add `NODE_VERSION=22` and `PUBLIC_TURNSTILE_SITE_KEY=<site key>`. The Cloudflare build reads these natively (it does **not** use mise — mise is the local/CI toolchain only), so the Build command stays a plain `npm run build`. Without the `PUBLIC_TURNSTILE_SITE_KEY` variable the site key never reaches Astro and the form is silently omitted. (The Build command also carries a branch-conditional `CLOUDFLARE_ENV=preview` wrapper for preview isolation — see `wrangler.jsonc` and the Deployment section.)
3. **Buttondown account**: sign up, copy API key, `wrangler secret put BUTTONDOWN_API_KEY`. In Settings → Newsletter → RSS-to-email, add `https://mjrossi.com/blog/rss.xml`. New posts then auto-email; the publishing flow stays "write MDX, `git push`."
4. **Rate limit (optional)**: Cloudflare → Security → WAF → add a rate-limit rule on `/api/subscribe` (e.g. 10 req/min/IP) as a layer above the in-handler honeypot + Turnstile check.
