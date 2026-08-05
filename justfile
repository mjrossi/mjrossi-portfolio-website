# mjrossi-portfolio-website — common dev commands.
# Run `just` (no args) to list recipes, organized by group.
#
# `just`, node, and (under MISE_ENV=development) wrangler are all pinned
# in mise.toml — a single `mise install` at the repo root provisions
# everything below.
#
# MISE_ENV convention (see CLAUDE.md "Newsletter" / "Running smoke"):
#   - dev/build/preview/smoke/ci recipes force MISE_ENV=development (or
#     =ci for `ci`) so the always-passes Turnstile test key is baked in
#     regardless of the caller's ambient shell state — this is the exact
#     failure mode CLAUDE.md documents at length.
#   - `deploy` deliberately leaves MISE_ENV unset, so it picks up the real
#     production PUBLIC_TURNSTILE_SITE_KEY from mise.toml's base [env].
#
# Groups: setup, dev, build, ops, assets, ci.

set shell := ["bash", "-cu"]

# ── default ──────────────────────────────────────────

# show available recipes, organized by group
[private]
default:
    @just --list --unsorted

# ── setup ────────────────────────────────────────────

# install npm dependencies from the lockfile
[group('setup')]
install:
    npm ci

# ── dev ──────────────────────────────────────────────

# astro dev server only — no worker, no Turnstile, no /api/* routes
[group('dev')]
dev:
    MISE_ENV=development mise exec -- npm run dev

# full build + wrangler dev — the only way to exercise the newsletter form
[group('dev')]
preview:
    MISE_ENV=development mise exec -- npm run preview

# ── build ────────────────────────────────────────────

# astro build (dev Turnstile test key baked in via MISE_ENV=development)
[group('build')]
build:
    MISE_ENV=development mise exec -- npm run build

# build then run the post-build smoke assertions — always rebuilds first
# so you can't accidentally smoke-test a stale bundle (see CLAUDE.md
# "Running smoke — read this before you debug a failure")
[group('build')]
[doc('build + run smoke assertions against a fresh build')]
smoke: build
    npm run smoke

# ── ops ──────────────────────────────────────────────

# wrangler secret put NAME — set a production Worker secret
# usage: just secret BUTTONDOWN_API_KEY
#        just secret TURNSTILE_SECRET_KEY
#        just secret PREVIEW_SIGNING_KEY
[group('ops')]
[doc('wrangler secret put NAME — set a production Worker secret')]
secret name:
    wrangler secret put {{name}}

# mint a signed, expiring link that reveals ONE scheduled post on its own
# URL — not /blog, tag pages, or RSS (see CLAUDE.md "Previewing a scheduled
# post"; that scoping is what keeps a review link away from the feed that
# triggers the Buttondown send). Needs PREVIEW_SIGNING_KEY in .dev.vars or
# the environment; without it the script exits with setup instructions.
#
# --reviewer LABEL adds permission to leave galley notes, attributed to that
# label. One link per editor; they need no account and no GitHub. The label is
# recorded on every note and lands in the committed review file, so use
# initials — nothing anonymises it later.
#
# This is the ONLY command that issues access. The galley reads and applies
# notes; it does not hand out links, which is why a link is withdrawn with
# `just preview-revoke` whether or not it names a reviewer.
#
# The link is recorded in the preview_links allowlist as it is minted, so it
# can be withdrawn later — see `just preview-roster` / `just preview-revoke`.
# That means minting needs D1: a token carrying D1:Edit, or --local for the
# database `just preview` and `just smoke` use.
#
# NOTE: a link you hand to someone else must point at production (the default),
# not a branch preview. *.workers.dev preview hosts sit behind Cloudflare
# Access, so an editor without a service token gets a login page instead of the
# post. That is why a draft is merged to main with a future pubDate before
# review — see CLAUDE.md, "The galley".
# usage: just preview-link my-draft
#        just preview-link my-draft --hours 4
#        just preview-link my-draft --reviewer jd
#        just preview-link my-draft --reviewer mr --hours 96
#        just preview-link my-draft --host http://127.0.0.1:8788 --local
[group('ops')]
[doc('mint a signed preview link for one scheduled post; --reviewer LABEL to allow notes')]
preview-link slug *flags:
    npm run preview-link -- {{slug}} {{flags}}

# list every preview link minted for a post, with its state (live, expired, or
# revoked). This is the ONLY inventory -- a token is recorded nowhere else, so
# a link missing from this list cannot be revoked, only waited out.
# usage: just preview-roster my-draft
#        just preview-roster my-draft --local
[group('ops')]
[doc('list the preview links outstanding for one post')]
preview-roster slug *flags:
    npm run preview-roster -- {{slug}} {{flags}}

# revoke a preview link. Takes READING away as well as writing: middleware
# refuses the whole grant, so the post 404s for that link. Rows are kept, so a
# revoked link stays visible in `just preview-roster`.
#
# Always scoped to the named post, so a mistyped id belonging to another draft
# does nothing rather than withdrawing someone else's link.
# usage: just preview-revoke my-draft a1b2c3d4e5f60718
#        just preview-revoke my-draft --revoke-all
[group('ops')]
[doc('revoke one preview link, or --revoke-all for a post')]
preview-revoke slug id *flags:
    npm run preview-roster -- {{slug}} {{ if id == "--revoke-all" { "--revoke-all" } else { "--revoke " + id } }} {{flags}}

# apply the D1 schema in migrations/ to the galley database. Run once against
# --remote before the first real review round, and against --local whenever a
# new migration lands (`just smoke` migrates the local database itself, so this
# is only needed for `just preview`/`just dev` sessions).
#
# --remote needs an API token carrying D1:Edit; without it wrangler reports
# "not authorized to access this service [code: 7403]", which is a token-scope
# problem rather than an account one — see CLAUDE.md, "The galley".
# usage: just galley-migrate --local
#        just galley-migrate --remote
[group('ops')]
[doc('apply migrations/ to the galley D1 database (--local or --remote)')]
galley-migrate target='--local':
    wrangler d1 migrations apply mjrossi-galley {{target}}

# pull editorial notes for a post into docs/galley/<slug>.md, ready to apply
# alongside the .mdx. Reads D1 through wrangler, which is already authenticated
# as you — there is no admin endpoint on the deployed worker.
# usage: just galley my-draft
#        just galley my-draft --local
[group('ops')]
[doc('pull galley notes for one post into docs/galley/')]
galley slug *flags:
    npm run galley -- {{slug}} {{flags}}

# manual fallback — Cloudflare Workers Builds deploys automatically on
# git push (see CLAUDE.md's Newsletter env table / dashboard build
# command). Use this when you need to ship from a branch Cloudflare
# hasn't built yet, or want to watch the build locally. MISE_ENV is left
# unset so the real production Turnstile key from mise.toml is used.
[group('ops')]
[doc('build + wrangler deploy — manual fallback; primary path is Cloudflare Workers Builds on git push')]
deploy:
    mise exec -- npm run deploy

# recover from a hard-killed smoke run: `scripts/smoke.mjs` traps
# SIGINT/SIGTERM to clean up wrangler dev, but a hard kill (timeout,
# kill -9, sandbox shutdown) leaves it orphaned on :8788.
[group('ops')]
[doc('kill orphaned wrangler/workerd processes stuck on :8788')]
kill-smoke:
    pkill -9 -f wrangler || true
    pkill -9 -f workerd || true

# ── assets ───────────────────────────────────────────

# regenerate public/og.png (social preview card)
[group('assets')]
og:
    node scripts/make-og.mjs public/og.png

# regenerate public/noise.webp (masthead grain overlay)
[group('assets')]
noise:
    node scripts/make-noise.mjs public/noise.webp

# ── ci ───────────────────────────────────────────────

# mirrors .github/workflows/build.yml: MISE_ENV=ci build + smoke
[group('ci')]
[doc('mirror build.yml: MISE_ENV=ci build + smoke')]
ci:
    MISE_ENV=ci mise exec -- npm run build
    npm run smoke

# trigger the Lighthouse audit workflow against a given URL (needs gh
# CLI auth); normally fires on Cloudflare check_suite completion instead
[group('ci')]
[doc('trigger the Lighthouse audit workflow against a URL (needs gh CLI)')]
lighthouse url:
    gh workflow run lighthouse.yml -f url={{url}}
