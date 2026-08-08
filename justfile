# mjrossi-portfolio-website — common dev commands.
# Run `just` (no args) to list recipes, organized by group.
#
# `just` and node are pinned in mise.toml — a single `mise install` at the
# repo root provisions everything below.
#
# wrangler is pinned in package.json, NOT mise — see the note in
# mise.development.toml for why it cannot be a mise tool. Every recipe that
# runs it goes through `npx wrangler`, so it resolves to that pin, the same
# one `npm run smoke`, `scripts/d1.mjs`, and Cloudflare Workers Builds use.
# (mise.toml also puts ./node_modules/.bin on PATH, so a bare `wrangler`
# typed in the shell is the same binary; `npx` here is belt-and-braces for
# a shell where mise isn't active.) That single pin is deliberate: wrangler
# bundles workerd, workerd owns the schema of `.wrangler/state`, and a
# second wrangler on PATH will fail to open state a newer one wrote:
#
#   Fatal uncaught kj::Exception: table _cf_ALARM has 3 columns but 2
#   values were supplied / The Workers runtime failed to start.
#
# That is a version-skew message, not a broken database — it means two
# wranglers touched one state directory. One pin, in package.json.
#
# MISE_ENV convention (see CLAUDE.md "Newsletter" / "Running smoke"):
#   - dev/build/preview/smoke/ci recipes force MISE_ENV=development (or
#     =ci for `ci`) so the always-passes Turnstile test key is baked in
#     regardless of the caller's ambient shell state — this is the exact
#     failure mode CLAUDE.md documents at length.
#   - `deploy` deliberately leaves MISE_ENV unset, so it picks up the real
#     production PUBLIC_TURNSTILE_SITE_KEY from mise.toml's base [env].
#
# Groups: setup, dev, build, review, ops, assets, ci.
#
# `review` is the draft-review workflow and is kept apart from `ops` on
# purpose: those recipes share one subject (an unpublished post and who may
# see it), one required flag (--remote|--local, no default anywhere), and one
# D1 database. `ops` is the unrelated remainder — secrets, deploys, and
# cleaning up after a hard-killed smoke run. They had grown into one
# fourteen-recipe list where the only way to tell a link command from a
# deploy command was to read every doc string.

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

# full build + wrangler dev on 127.0.0.1:8788 — the only way to exercise the
# newsletter form, and the host a --local preview link must point at. The port
# is pinned (in package.json) rather than left to wrangler's default so it
# matches `just smoke` and the --host examples below are actually correct;
# they used to name 8788 while this served 8787.
[group('dev')]
[doc('full build + wrangler dev on 127.0.0.1:8788 — the only way to exercise the form, or the galley end to end')]
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

# the galley margin against fixtures — no build, no worker, no database.
#
# The markers are the one part of this repo whose correctness is a RENDERING
# question, and neither `just test` nor `just smoke` can see a pixel. This is
# what you look at before believing a change to GalleyMargin.astro or to
# markAnchors; the alternative was a build, a migration, wrangler dev, a minted
# link and a filed note before a single marker appeared. Reads its CSS out of
# the component and loads the real /scripts/galley.js, so nothing here can
# render something production doesn't. `--shot FILE` writes a PNG if a headless
# Chrome happens to be installed.
#
# `--stale` puts the page a revision behind the server, which is the other state
# markAnchors has to get right: every marker withheld, the reload prompt raised,
# and a save refused. Without the flag the two revisions always agree and that
# whole gate is unrenderable.
[group('dev')]
[doc('render the galley margin against fixtures on 127.0.0.1:8790 — no worker, no D1')]
galley-preview *flags:
    node scripts/galley-preview.mjs {{flags}}

# ── review ───────────────────────────────────────────
#
# Everything to do with showing an unpublished draft to somebody and getting
# their notes back. All of it is scoped to one post, all of it requires an
# explicit --remote or --local, and all of it reads or writes the same D1
# database (`just galley-migrate`).
#
# One vocabulary for access: links are minted, listed, extended, and revoked
# with the preview-* recipes whether or not they name a reviewer. The galley
# owns the notes, not the letting-in — see CLAUDE.md, "The galley".

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
# That means minting needs D1: --remote needs a token carrying D1:Edit, and
# --local needs a migrated dev database (`just galley-migrate --local`).
#
# --remote or --local is REQUIRED. There is no default, because minting against
# the wrong database is silent at the time and surfaces as a 404 in somebody
# else's browser — see scripts/database-target.mjs.
#
# NOTE: a link you hand to someone else must point at production, not a branch
# preview. *.workers.dev preview hosts sit behind Cloudflare Access, so an
# editor without a service token gets a login page instead of the post. That is
# why a draft is merged to main with a future pubDate before review — see
# CLAUDE.md, "The galley".
# usage: just preview-link my-draft --remote
#        just preview-link my-draft --remote --hours 4
#        just preview-link my-draft --remote --reviewer jd
#        just preview-link my-draft --remote --reviewer mr --hours 96
#        just preview-link my-draft --local --host http://127.0.0.1:8788
[group('review')]
[doc('mint a signed preview link for one scheduled post (--remote|--local); --reviewer LABEL to allow notes')]
preview-link slug *flags:
    npm run preview-link -- {{slug}} {{flags}}

# list every preview link minted for a post, with its state (live, expired, or
# revoked). This is the ONLY inventory -- a token is recorded nowhere else, so
# a link missing from this list cannot be revoked, only waited out.
#
# --remote or --local is REQUIRED. Listing the wrong database answers "no links
# minted" for one you never looked at, which is the most reassuring possible
# wrong answer — see scripts/database-target.mjs.
# usage: just preview-roster my-draft --remote
#        just preview-roster my-draft --local
[group('review')]
[doc('list the preview links outstanding for one post (--remote|--local)')]
preview-roster slug *flags:
    npm run preview-roster -- {{slug}} {{flags}}

# list EVERY preview link in the table, across all posts, grouped by post.
#
# The per-post scoping elsewhere is load-bearing in the worker — handing someone
# one draft must not hand them the rest — but that does not reach a CLI already
# authenticated as you. Without this, a link whose slug you have forgotten
# cannot be revoked at all, only waited out: `just preview-roster` needs the
# slug to answer, and a token is recorded nowhere else.
#
# Reading only. Revoking stays per-post (`just preview-revoke`), so a mistyped
# id can never withdraw another draft's link.
# usage: just preview-roster-all --remote
#        just preview-roster-all --local
[group('review')]
[doc('list every preview link across all posts (--remote|--local)')]
preview-roster-all *flags:
    npm run preview-roster -- --all {{flags}}

# move a live link's expiry without minting a new one. THE URL DOES NOT CHANGE
# — there is nothing to re-send, which is the whole point: before this, "give
# them another two days" meant a second link, a second URL, and the first one
# still live until it lapsed.
#
# --hours is a new window measured FROM NOW, not time added to what is left, so
# this shortens as readily as it extends. A link can never be pushed past the
# ceiling it was signed with when it was minted (30 days out), nor past the post's
# own pubDate — once the post is public the link has nothing left to grant. Past
# either, mint a fresh one. `just preview-roster` shows the reachable limit as
# `extend to <date>`.
#
# --remote or --local is REQUIRED. Extending the wrong database reports success
# while the link the reviewer holds goes on expiring.
# usage: just preview-extend my-draft a1b2c3d4e5f60718 --remote
#        just preview-extend my-draft a1b2c3d4e5f60718 --hours 96 --remote
[group('review')]
[doc('move the expiry of a live preview link — the URL is unchanged (--remote|--local)')]
preview-extend slug id *flags:
    npm run preview-extend -- {{slug}} {{id}} {{flags}}

# re-clamp EVERY live link for a post. This is the command for "I pushed the
# date out": a link's expiry is capped at the post's pubDate when it is minted,
# so moving that date leaves every outstanding link expiring on the old one.
#
# It works because minting caps the ROW but leaves the SIGNATURE ceiling 30 days
# out, so a slipped launch still has headroom to extend into. As with a single
# link, not one URL changes — nothing is re-sent and no reviewer learns their
# link was about to lapse.
#
# Exits non-zero if any live link could not be moved, naming it: a link signed
# with a ceiling short of the new date has to be reminted.
# usage: just preview-extend-all my-draft --remote --hours 120
[group('review')]
[doc('re-clamp every live preview link for a post after moving its pubDate (--remote|--local)')]
preview-extend-all slug *flags:
    npm run preview-extend -- {{slug}} --all {{flags}}

# revoke a preview link. Takes READING away as well as writing: middleware
# refuses the whole grant, so the post 404s for that link. Rows are kept, so a
# revoked link stays visible in `just preview-roster`.
#
# Always scoped to the named post, so a mistyped id belonging to another draft
# does nothing rather than withdrawing someone else's link. Reports what it
# actually withdrew — "nothing to revoke" is a distinct outcome from success.
#
# Revoking is final: a revoked row cannot be extended back to life. If the link
# is fine and only the window is short, `just preview-extend` is the gentler
# instrument and leaves the reviewer's URL alone.
#
# --remote or --local is REQUIRED; revoking the wrong database leaves a live
# link live while telling you it is gone.
# usage: just preview-revoke my-draft a1b2c3d4e5f60718 --remote
#        just preview-revoke my-draft --revoke-all --remote
[group('review')]
[doc('revoke one preview link, or --revoke-all for a post (--remote|--local)')]
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
#
# The target is REQUIRED. This used to default to --local while every other D1
# recipe defaulted to production, which is the single most confusing thing about
# this command group: the same bare invocation meant "dev" here and "production"
# three lines up.
# usage: just galley-migrate --local
#        just galley-migrate --remote
[group('review')]
[doc('apply migrations/ to the galley D1 database (--local or --remote)')]
galley-migrate target:
    @case "{{target}}" in \
      --local|--remote) ;; \
      *) echo "galley-migrate: pass --local or --remote, got '{{target}}'" >&2; exit 1 ;; \
    esac
    npx wrangler d1 migrations apply mjrossi-galley {{target}}

# pull editorial notes for a post into docs/galley/<slug>.md, ready to apply
# alongside the .mdx. Reads D1 through wrangler, which is already authenticated
# as you — there is no admin endpoint on the deployed worker.
#
# Pulls OPEN notes only — a round you have closed stays out of the way. Add
# --all to include closed ones. Every note is printed with its id, which is what
# `just galley-close` reads back.
#
# --remote or --local is REQUIRED. Pulling the wrong one reports "no notes" for
# a post that has them, which reads like the editors never wrote any.
# usage: just galley my-draft --remote
#        just galley my-draft --remote --all
[group('review')]
[doc('pull open galley notes for one post into docs/galley/ (--remote|--local, --all)')]
galley slug *flags:
    npm run galley -- {{slug}} {{flags}}

# end a review round: close the notes listed in docs/galley/<slug>.md.
#
# RUN IT AFTER THE REVISION MERGES. Closing first retires notes whose fixes are
# not in the file yet.
#
# It closes exactly the ids in that file, and this is the whole point. The
# obvious rule — "close everything written against an older revision" — is wrong
# as soon as a second reviewer exists: their notes drift when you merge the
# first reviewer's round, and a drift-based close would retire feedback nobody
# has read. The pulled file is what you actually worked through, so anything
# filed after that pull is out of reach by construction. The command says how
# many it left open, and who filed them.
#
# --remote or --local is REQUIRED. Closing the wrong database reports success
# while the reviewer's margin goes on showing every note you just applied.
# usage: just galley-close my-draft --remote
#        just galley-close my-draft --remote --note 1111...-...
[group('review')]
[doc('close the notes listed in docs/galley/<slug>.md — ends a round (--remote|--local)')]
galley-close slug *flags:
    npm run galley-close -- {{slug}} {{flags}}

# put one closed note back. The undo for galley-close.
#
# One note at a time, never bulk: closing is the routine act, re-opening is the
# correction, and a correction should make you name what you mean. Ids come from
# `just galley <slug> --all`, which lists closed notes with theirs.
#
# --remote or --local is REQUIRED.
# usage: just galley-reopen my-draft --note 1111...-... --remote
[group('review')]
[doc('re-open one closed galley note (--remote|--local)')]
galley-reopen slug *flags:
    npm run galley-reopen -- {{slug}} {{flags}}

# ── ops ──────────────────────────────────────────────
#
# The unrelated remainder: secrets, deploys, and cleaning up after a smoke run
# that was hard-killed. Anything to do with drafts and who may read them is in
# `review` above.

# wrangler secret put NAME — set a production Worker secret
# usage: just secret BUTTONDOWN_API_KEY
#        just secret TURNSTILE_SECRET_KEY
#        just secret PREVIEW_SIGNING_KEY
[group('ops')]
[doc('wrangler secret put NAME — set a production Worker secret')]
secret name:
    npx wrangler secret put {{name}}

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
#
# EXPECT THE NEXT RUN TO BE FLAKY. SIGKILL leaves the local D1 SQLite WAL
# uncheckpointed, and the following `wrangler dev` startup is unreliable
# against it — a galley check fails with "got 500" on a path that never
# touches D1, then the worker dies and the run ends "fetch failed". It
# recovers on the run after. Re-run before investigating.
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
