# Newsletter

The blog index and the foot of every published post carry an email signup that forwards to Buttondown via `src/pages/api/subscribe.ts`. Buttondown polls `/blog/rss.xml` and emails new posts automatically, so publishing stays "write MDX, `git push`."

Split out of `CLAUDE.md`, which keeps the JS carve-out rule and the env-var summary. This file has the full env sourcing table and the operator-side Buttondown design. For how mise and wrangler divide ownership of those variables, see [ENVIRONMENT.md](ENVIRONMENT.md).


The blog index and the foot of every published post carry an email signup form (`src/components/Subscribe.astro`, one implementation with a `line` / `card` variant) that forwards to Buttondown via `src/pages/api/subscribe.ts`. Buttondown polls `/blog/rss.xml` and emails new posts automatically — the publishing flow stays "write MDX, `git push`."

**JS carve-out:** This is one of the two client-side JavaScript carve-outs (the other is the galley review client, which only loads on a signed review link). The Turnstile loader + form handler load on `/blog` **and on every published post** — that widening is the deliberate cost of the August 2026 review's placement D, and it is where the carve-out stops. Do not lift `Subscribe.astro` into `Base.astro` or any shared chrome, and do not render it on a draft: `BlogPost.astro` gates the card on `isPublished`, so a galley reader never meets a signup form on the post they are reviewing. Smoke asserts the form is absent on `/` as a regression guard.

**Env vars** (see `mise.local.toml.example` and `.dev.vars.example`):

| Variable | Where | Source (all environments) |
|---|---|---|
| `PUBLIC_TURNSTILE_SITE_KEY` | Astro build (`import.meta.env`) — baked into HTML | `mise.toml` `[env]` (commits the real production site key — it's public by design). `mise.development.toml` overrides with the always-passes test key when `MISE_ENV=development` (recommended local shell setting). `mise.ci.toml` does the same when `MISE_ENV=ci` (set in `build.yml`). `mise.local.toml` (gitignored) can override anything for machine-specific testing. |
| `BUTTONDOWN_API_KEY` | Worker runtime (`import { env } from 'cloudflare:workers'`) | `.dev.vars` locally; `wrangler secret put` in production |
| `TURNSTILE_SECRET_KEY` | Worker runtime (`import { env } from 'cloudflare:workers'`) | `.dev.vars` locally; `wrangler secret put` in production |
| `PREVIEW_SIGNING_KEY` | Worker runtime, **and** `scripts/preview-link.mjs` on the host | `.dev.vars` locally; `wrangler secret put` in production. Optional — unset means preview links are rejected and only the `*.workers.dev` unlock works. See "Previewing a scheduled post". |
| `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD` | Worker runtime | `vars` in `wrangler.jsonc` — **not** secrets. Account-scoped identifiers that confer nothing without a JWT Cloudflare signed, so they belong in committed config like the KV `id`. Ship as `REPLACE-ME` placeholders; until they are real the Desk 404s for everyone. See "The Desk". |
| `ACCESS_JWKS_OVERRIDE` | Worker runtime | `.dev.vars` **only**, and normally unset. Replaces the trust root for `/admin` so the Desk is reachable without Cloudflare Access in front of it. `just smoke` injects its own and refuses to run if `.dev.vars` would shadow it. Never `wrangler secret put` this. |

For Cloudflare Workers Builds to pick up `mise.toml`'s `[env]` block, the **build command** in the dashboard must activate mise — `mise install && mise exec -- npm run build` (rather than the default `npm run build`). Cloudflare reads `[tools]` automatically but does not auto-activate `[env]`.

`Subscribe.astro` gracefully degrades when `PUBLIC_TURNSTILE_SITE_KEY` is missing — the form is omitted and a `console.error` is logged to Worker observability, but the rest of `/blog` renders normally. (Because `/blog` is on-demand, `import.meta.env.PUBLIC_*` is inlined at build time but the missing-value check only fires at request time. Throwing here would 500 the entire blog for visitors; logging-and-omitting is the right trade.) If a runtime secret is missing, the endpoint returns `500 { error: 'turnstile_secret_missing' }` or `{ error: 'buttondown_key_missing' }` — names the specific binding so the operator can fix without checking Worker logs.

## Buttondown email design (operator-side)

The email design lives in three files in `docs/` — source of truth is the repo; Buttondown's dashboard is the copy that actually serves emails. Re-paste when these change:

| File | Buttondown slot |
|---|---|
| `docs/buttondown-rss-template.md` | RSS-to-email automation → **Template** field |
| `docs/buttondown-email-custom.css` | Email design → **Custom CSS** |
| `docs/buttondown-web-custom.css` | Web design → **Custom CSS** (Buttondown's hosted archive page) |

**The template's colophon is pinned to `src/lib/identity.js`.** `Set in Fraunces &amp; Source Serif · Built in Astro, served from the edge.` is `SET_IN` + `BUILT_WITH`, spelled as literal markdown because this file is pasted into a dashboard and can't import anything. `scripts/smoke/static.mjs` asserts it still matches, so rewriting either sentence fails the build until the template is updated — and then it still has to be **re-pasted into Buttondown**, which nothing here can check. Green smoke means the repo agrees with itself, not that the dashboard is current.

The Email design **Header** slot is text-only (inline HTML is emitted as literal characters), so the masthead ribbon — which needs a `<span>` for the two-tone accent on "LEXICON" — lives in the RSS template body, not the Header slot. Leave Header toggled off. Free-form broadcast emails therefore don't carry the masthead; RSS-to-email mailings do. RSS-to-email is the primary surface, so this is acceptable.

The RSS-to-email automation also has a separate **Subject** field (not in the repo, set in the dashboard). Use:

```
The Urbanist Lexicon · {{ item.title }}
```

Prefixing with the periodical name helps subscribers identify the email in a busy inbox.

