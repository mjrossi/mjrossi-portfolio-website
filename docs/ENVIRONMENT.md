# Environment, local development, and smoke

Who owns which variable, how to run the site locally, and how to read a smoke failure. Split out of `CLAUDE.md`, which keeps the commands and the two gotchas that bite most often.

**The one-line version:** mise owns shell-level vars (build-time, public). Wrangler owns worker runtime secrets via `.dev.vars`. No variable appears in both files, and putting a worker secret in `mise.local.toml` is either inert or actively harmful — see "How mise and wrangler relate" below.

**mise is the single source of truth for shell-level vars.** `mise.toml` pins Node 22 and commits the production `PUBLIC_TURNSTILE_SITE_KEY` (public by design). Two committed overrides switch in the always-passes Turnstile test key under specific contexts: `mise.development.toml` (when `MISE_ENV=development`, the recommended local-dev default) and `mise.ci.toml` (when `MISE_ENV=ci`, set in `.github/workflows/build.yml`). `mise.local.toml` (gitignored) remains available for machine-specific overrides on top of those. `jdx/mise-action` exports `[env]` to `GITHUB_ENV` so subsequent steps see the values. Cloudflare Workers Builds picks up `mise.toml` via the build command (`mise install && mise exec -- npm run build`).

## How mise and wrangler relate

These are two separate ownership layers; **no variable appears in both files, no tool reads from the other's file**, no circular dependency:

- **mise → shell env → Astro build.** mise's `[env]` table sets shell environment variables. Astro/Vite reads them via `process.env` / `import.meta.env` at build time. Only `PUBLIC_*` vars are ever surfaced this way — they're public by design (they end up in static HTML).
- **wrangler → `.dev.vars` → Worker runtime.** Wrangler dev reads `.dev.vars` at startup and injects the values into the Worker's `env` binding namespace. These never reach shell env, the browser, or any other tool's `process.env`. In production, `wrangler secret put` replaces `.dev.vars` (encrypted at rest in Cloudflare's secret store).

**mise does not pin wrangler, and must not start.** mise's own Node cookbook endorses declaring npm CLIs as mise `[tools]`, and that is right for tools the build merely *runs* (tsc, eslint). wrangler is not one: it is a `peerDependency` of `@astrojs/cloudflare` and is imported as a library by `@cloudflare/vite-plugin` during `astro build`, so it must resolve from `node_modules` no matter what — a mise pin could only ever duplicate the `package.json` one, never replace it. And a duplicate is not inert here, because wrangler bundles workerd and **workerd owns the schema of `.wrangler/state`**: an older wrangler cannot open state a newer one has written, and dies at runtime startup with `table _cf_ALARM has 3 columns but 2 values were supplied` / `The Workers runtime failed to start`. That message is version skew between two wranglers, not a corrupt database — the D1 rows are fine. This happened: `mise.development.toml` held 4.90.1 while `package.json` held 4.115.0, and `just galley-migrate --local` (the one recipe then calling bare `wrangler`) died before reaching the migration. The fix has three parts, all of which matter — every recipe and script invokes `npx wrangler`; `mise.toml` puts `{{config_root}}/node_modules/.bin` on PATH via `[env] _.path`, so a bare `wrangler` typed in the shell is also the pinned one; and `mise.development.toml` carries a note telling the next person not to re-add the pin.

That separation is intentional: keeping worker secrets out of shell env means only wrangler can see them — a small but real defense-in-depth boundary that we don't want to collapse just to centralise into one file. "Prefer mise where possible" means mise is the default for shell-level vars; wrangler's `.dev.vars` exists because runtime secrets belong to wrangler's contract, not because we're doubling up.

**One documented exception.** `PREVIEW_SIGNING_KEY` lives in `.dev.vars` like the others, but `scripts/preview-link.mjs` also reads it directly from that file when minting a link. HMAC has no way around this — the signing side and the verifying side must hold the same key, and the signing side is a local script. The exception is deliberately narrow: it's a signing key for unpublished blog drafts, not a credential for any external service, so the cost of the leak-surface it adds is small. Don't generalise from it — `BUTTONDOWN_API_KEY` and `TURNSTILE_SECRET_KEY` stay wrangler-only.

**`mise.local.toml` is the one file that can break this silently.** It is gitignored, so nothing in review or CI can see what it sets, and mise's `[env]` wins for shell-level vars. For the two wrangler-only secrets that makes a copy there invisible *and* inert: `wrangler dev` injects `.dev.vars` into the Worker's `env` binding regardless, and `src/pages/api/subscribe.ts` only ever reads `env.TURNSTILE_SECRET_KEY`, never `process.env`. So the copy does nothing except widen the blast radius — a production secret exported into every process on the machine. This happened with `TURNSTILE_SECRET_KEY` and was removed. If you are debugging `BUTTONDOWN_API_KEY` or `TURNSTILE_SECRET_KEY`, check `.dev.vars`; adding either to `mise.local.toml` will not help and should not be tried.

**`PREVIEW_SIGNING_KEY` is the exception to that, and it fails in the opposite direction — not inert, but split-brained.** `scripts/preview-link.mjs` reads `process.env.PREVIEW_SIGNING_KEY` *before* falling back to `.dev.vars`, so a value in `mise.local.toml` wins **for minting only**. The worker (which sees `.dev.vars` via `wrangler dev`) and `smoke.mjs` (which calls `readDevVar` exclusively) both keep the old key, so `npm run preview-link` starts producing links the site rejects, with nothing in the output saying why. That is precisely the signing/verifying drift `scripts/dev-vars.mjs` exists to prevent, reintroduced one layer up. Keep this key in `.dev.vars` only.

## Local development workflow

Both env files have `.example` siblings; copy and edit:

```
cp mise.local.toml.example mise.local.toml   # PUBLIC_TURNSTILE_SITE_KEY
cp .dev.vars.example .dev.vars               # BUTTONDOWN_API_KEY, TURNSTILE_SECRET_KEY
```

The defaults work end-to-end except for the actual Buttondown call (placeholder API key 401s, endpoint returns 502 to the client — visible in dev tools). Replace `BUTTONDOWN_API_KEY` with a real free-tier key for a full happy path.

Then:

- `npm run dev` — Astro dev server only. No worker, no Turnstile, no `/api/*` routes.
- `npm run preview` — full build + `wrangler dev`. Only way to exercise the form.
- `npm run smoke` — runs the post-build assertions including `/api/subscribe` sad paths.

## Running smoke — read this before you debug a failure

**`PUBLIC_TURNSTILE_SITE_KEY` must be exported in the shell at build time, every time.** This trips people up regularly. `import.meta.env.PUBLIC_TURNSTILE_SITE_KEY` is inlined into the bundle by Vite during `astro build`; if the var isn't set when `npm run build` runs, the form never reaches the HTML and four smoke assertions go red:

```
✗ blog index: newsletter form present
✗ blog index: Turnstile script tag
✗ blog: submit handler is external (/scripts/newsletter.js) — no external /scripts/newsletter.js <script src> found in blog HTML
✗ blog: follow note is OUTSIDE the newsletter aside — blog-follow-note appears inside .newsletter — ad blockers will hide it
```

When you see that signature, the bug is **build-time env**, not the assertions. Rebuild with the var set.

The tidy way is to activate mise — `mise.development.toml` and `mise.ci.toml` both export the documented Turnstile always-passes test key (`1x00000000000000000000AA`):

```sh
MISE_ENV=development mise exec -- npm run build && npm run smoke
# or, if mise auto-activates via shell hook:
mise install && npm run build && npm run smoke
```

If mise isn't installed locally, set the test key directly before the build:

```sh
PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA npm run build && npm run smoke
```

CI handles this via `MISE_ENV=ci` in `.github/workflows/build.yml`, so the issue only bites in a fresh local shell without mise active.

**Other smoke gotchas worth knowing:**

- **`wrangler dev` died mid-run, and smoke exited 75.** A handler somewhere returned a response without reading the request body it was sent. `wrangler dev` puts a ProxyWorker between the client and the Worker, and an unread body leaves that hop holding a stream nobody drains; after enough of them the connection goes with `Network connection lost.`, wrangler's ProxyController treats that as fatal, and the dev server exits partway through the run. Production Cloudflare does not care, so this is a local-dev and CI failure only — but it takes out `just preview` too, for anyone whose review link has been revoked while the galley client keeps posting.

  `refuse` in `src/lib/server.ts` is the fix, and it **drains** (`arrayBuffer()`) rather than cancelling. That looks backwards — `request.body.cancel()` is the tidy-looking option — but cancelling does not release the hop. Measured against `/api/galley` with 400 unauthorised POSTs: no drain died at request 29, `cancel()` died at 20, `arrayBuffer()` went 400-for-400 and stayed up. Don't optimise it back to a cancel. Any new early return from a handler that can be sent a body belongs behind it; the one deliberate exception is `parseJson`'s 413, which is the single refusal that is *about* the body being too large.

  Recognise it by the report, which names it: `smoke: wrangler dev EXITED MID-RUN` (or `is NOT ANSWERING`), followed by the tail of wrangler's own log. Everything listed above that line is collateral — requests in flight when the runtime went away come back `500`, and the rest are refused. Before smoke knew to say so this surfaced as four galley assertions failing, including "a valid token wrote to a post it was not minted for", which is alarming and was never true. The exit code is 75 rather than 1 to keep that distinction machine-readable. CI does **not** retry it: that was tried, and both attempts died at the same check.

- **A previous smoke run left wrangler running.** The script spawns `wrangler dev` on port 8788 and traps SIGINT/SIGTERM to clean up, but a hard kill (timeout, `kill -9`, sandbox shutdown) leaves the process orphaned. Symptom: smoke prints `Address already in use (127.0.0.1:8788)` and bails. Fix: `just kill-smoke` (or `pkill -9 -f wrangler && pkill -9 -f workerd`, confirmed with `lsof -i :8788`), then re-run.
- **The run *after* a hard kill can fail once, and it does not look like a toolchain problem.** `kill -9` leaves the local D1 SQLite WAL uncheckpointed (`.wrangler/state/v3/d1/**/*.sqlite-wal`, which can be a couple of hundred KB), and the next `wrangler dev` startup is unreliable against it. Observed twice, both times immediately after a `pkill -9`: a galley check fails with `got 500` on a request that should never reach D1, then the worker dies and the rest of the run reports `smoke: ERROR — fetch failed`. Six runs with no preceding hard kill all passed. **Just run it again** — the state recovers on the next clean open. Only start investigating if it fails twice in a row without a kill in between.
- **Cold-start wrangler can take 30–60s** in slow environments. The script's internal `READY_TIMEOUT_MS` is 30s; if your wrapper has its own timeout, give smoke at least 2 minutes end-to-end.
- **Build is stale.** Smoke reads `dist/client/` plus on-demand routes from the worker bundle. If you tweak source files and run smoke without rebuilding, you're testing the previous build. Always `npm run build && npm run smoke` together (or use the chained commands above).

## Preview deploys

PR branches get preview URLs from Cloudflare Workers Builds. **Preview deploys currently share production secrets** — a subscription via a preview URL lands in the production Buttondown account. Acceptable for a personal site (preview URLs are `noindex`'d). `wrangler.jsonc` carries a commented scaffold for isolating preview into its own environment if that ever needs to change.
