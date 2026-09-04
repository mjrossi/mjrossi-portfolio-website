# Preview links and scheduled-post access

How an unpublished post is made visible to someone, and how that visibility is taken back. Split out of `CLAUDE.md`, which keeps the commands and the invariants a change elsewhere can break.

**Read this before touching `src/lib/preview.js`, `src/lib/preview-links.js`, `src/middleware.ts`, or any `scripts/preview-*.mjs`.** The load-bearing property throughout: a signed link grants **one post's own URL** and never `/blog`, tag pages, or `/blog/rss.xml` — the feed is what triggers Buttondown's irreversible send to real subscribers.

## Previewing a scheduled post

Two unlocks, both resolved in `src/middleware.ts` and both **fail-closed** (an unrecognised host with no valid signature hides drafts, exactly as production does). The predicates live in `src/lib/preview.js` — plain JS, same rationale as `schedule.js`, using `globalThis.crypto.subtle` so one module serves the worker, `node --test`, and the minting script.

**1. PR preview deploys — automatic.** Any request to a `*.workers.dev` **branch/version** hostname reveals *every* scheduled post, across the index, tag pages, post URLs, and RSS. Push a branch, open the Cloudflare preview URL, and your drafts are there. No secret and no flag — but see the dashboard caveat below, which is load-bearing.

The host check is an allowlist with two exclusions, both of which matter:

- Anchored on the leading dot, so `evil-workers.dev` does **not** match.
- **The Worker's own production alias does not match.** Cloudflare enables `<worker-name>.<subdomain>.workers.dev` by default, and it serves *production*. The subdomain is not a secret — it's recoverable from the Cloudflare check run on any commit, and from `docs/ARCHITECTURE.md`. Left unhandled, that hostname would hand every scheduled draft, RSS included, to anyone who read this repo, with no token at all — defeating the whole point of scoping signed links. `isPreviewHost` therefore rejects a hostname whose first label is exactly `WORKER_NAME`, **and** `wrangler.jsonc` sets `"workers_dev": false` to turn the alias off. `smoke.mjs` asserts both halves, including that `WORKER_NAME` still matches `name` in `wrangler.jsonc` — a rename that broke the pairing would silently re-open the hole.

**`preview_urls` must stay pinned to `true` in `wrangler.jsonc`, and this is not decoration.** Per-branch preview URLs are a separate setting from `workers_dev`, but they are not independent of it by default: `preview_urls` defaults to **false** in wrangler's config schema, and when the key is absent from the file wrangler resolves it from server-side state at deploy time — it warns that "your `preview_urls` setting is not in your Wrangler file" and then tracks the workers.dev route status, which `"workers_dev": false` just turned off. Left implicit, a deploy could therefore disable the very hostnames this unlock runs on, and it would look like a Cloudflare outage rather than a config change. wrangler warns about the `workers_dev: false` + `preview_urls: true` pairing but honours it.

Two things to know before pointing anything automated at a preview URL — both learned the hard way by a Lighthouse workflow that has since been scoped back to production for exactly these reasons (see `docs/ARCHITECTURE.md`):

- **Don't reconstruct the preview hostname — read it from Cloudflare's check run.** The alias is not just a slugified branch name; Cloudflare truncates it to 32 chars plus a 4-char hash. Slugifying a long dependabot branch yields a 76-character DNS label against a 63-character limit, which doesn't resolve at all.
- **These hosts are behind Cloudflare Access.** Anything automated that fetches a preview URL needs the `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` service token, or it silently gets a login page instead of the site — and handing that token to a preview Worker means handing it to whatever code that branch deployed, which is why fork PRs can never be audited this way. Note that this Access layer, not `isPreviewHost`, is currently what keeps scheduled drafts on preview hosts away from the public.

`localhost` and `127.0.0.1` are deliberately **excluded** — that keeps `npm run preview` and `npm run smoke` on the real production code path, which is what makes smoke's "no future-dated RSS items" assertion meaningful. Use `npm run dev` to preview drafts locally.

Host-based authorization is the weakest primitive here by construction: `context.url.hostname` comes from the request, so the unlock's strength is Cloudflare's routing, not this code. That is an acceptable trade for hiding drafts. Do not extend the pattern to anything that matters more.

**2. Signed expiring links — for the production domain.** Reveals **one** post, on any host:

```sh
npm run preview-link -- my-draft --remote                 # 48h, mjrossi.com
npm run preview-link -- my-draft --remote --hours 4
npm run preview-link -- my-draft --local --host http://127.0.0.1:8788
# → https://mjrossi.com/blog/my-draft/?preview=my-draft.1784634245.a1b2c3d4e5f60718.74ad2a0d…
```

The URL goes to stdout and the metadata to stderr, so it pipes cleanly. The script refuses to mint a link for a slug with no matching file — a typo would otherwise produce a valid-looking link that 404s.

**Signed links are scoped to the post's own URL and nothing else.** They do not add the draft to `/blog`, tag pages, or `/blog/rss.xml`. That is deliberate and load-bearing: the RSS feed is what triggers Buttondown's email — an irreversible send to real subscribers — so a link you hand to a reviewer must not be able to reach it. `getPublishedPosts` therefore takes only a boolean `showScheduled`; the per-slug signal (`Astro.locals.previewSlug`) is read solely by `src/pages/blog/[...slug].astro`.

`smoke.mjs` guards this two ways, because neither alone is sufficient:

- **Source greps** assert the post route still honours `previewSlug` and that the identifier has **not** leaked into `blog.ts` or the RSS route. Treat these as *diagnostics, not coverage*: the live matrix below strictly dominates them on the surfaces they check, and a leak written directly into `index.astro` or `tag/[tag].astro` passes all of them. What they buy is a fast, pre-`wrangler` failure that names the exact file and invariant — without them the same bug surfaces 90 seconds later as "a signed preview link reached the feed" with no pointer to where.
- **A live matrix** against `src/content/blog/smoke-scheduled-fixture.mdx`, a permanently future-dated fixture post (`pubDate: 2099-01-01`). Over HTTP it asserts the post is absent from `/blog` and RSS and 404s at its own URL with no token; that a valid signed token opens its own URL with `no-store` + `noindex`; that a validly-signed token minted for a *different* slug still 404s the fixture (the case a signature check alone cannot catch); and — the direction the source greps cannot see — that the **same valid token still leaves it absent from `/blog` and `/blog/rss.xml`**. The fixture exists because every real post is past-dated, so without it there is nothing for a leak to expose and the suite stays green through the bug.
- **Both directions of the host unlock**, by setting a `Host` header on requests to the local worker. A `smoke-<worker-name>.example.workers.dev` host must reveal the fixture on `/blog`, its own URL, *and* RSS (the host unlock is broader than a signed link by design) with `no-store` + `noindex`; the bare `<worker-name>.example.workers.dev` production alias must reveal nothing and stay cacheable. The positive direction is the one that matters operationally — `isPreviewHost` is a well-unit-tested pure function, but nothing else proves it is still *wired* to the routes, and a dropped `showScheduled` argument fails closed and would otherwise go unnoticed.

The fixture is visible in `npm run dev` and on `*.workers.dev` previews. That is expected — both surfaces show scheduled posts on purpose.

The token is `<slug>.<exp>.<linkId>.<hmac>`, or `<slug>.<exp>.<reviewer>.<linkId>.<hmac>` when it also grants galley notes. Every field except the signature is inside the signed payload, so a link minted for one draft cannot be edited to open another, a view-only link cannot have a reviewer spliced in, and the link id cannot be repointed at a different allowlist row. Verification uses `crypto.subtle.verify` (constant-time) and checks the signature *before* expiry.

The token's signed `exp` is a **ceiling**, not the working expiry — see "Every link is revocable and extendable" below.

Any response with either unlock active gets `Cache-Control: no-store` and `X-Robots-Tag: noindex, nofollow`, **overriding** whatever was set. This is the one place middleware overrides rather than setting-if-absent — a cached or indexed draft is precisely the failure being avoided.

## Every link is revocable and extendable, and that is what `preview_links` is for

**And every link ends when its post does.** `just preview-link` caps the row's `exp` at the post's `pubDate`, so a link expires exactly as the post goes live — no gap, no overlap. That is the answer to "what happens to outstanding links after the scheduled time": nothing needs doing. The galley closes, `no-store` lifts, and `just preview-roster` reports the row as `spent (published <date>)` rather than `live`.

**A signature is necessary but not sufficient.** Every minted link — view-only and review alike — gets a row in the `preview_links` table, and `src/middleware.ts` requires that row, un-revoked **and unexpired**, before the token grants anything. Manage one with:

```sh
just preview-roster my-draft --remote                              # what is outstanding, and its state
just preview-roster-all --remote                                   # every link, across all posts
just preview-extend my-draft a1b2c3d4e5f60718 --hours 96 --remote  # more time, same URL
just preview-extend-all my-draft --hours 120 --remote              # after moving pubDate — every link, same URLs
just preview-revoke my-draft a1b2c3d4e5f60718 --remote             # take one back
just preview-revoke my-draft --revoke-all --remote                 # take back every live link
```

**Revoking removes reading as well as writing** — the post 404s for that link. Taking a draft back from someone should take the draft, not just the comment box. Rows are never deleted, so a withdrawn link stays listed as `revoked <date>` rather than vanishing from the inventory. Revoking is final: a revoked row cannot be extended back to life.

**There is one clock, and a cap on how far it can be wound. That split is what makes extending possible.**

> The row says *this link works until Y*. The signature says *and it can never be wound past X*. Extending moves Y. Past X you mint a new link.

`Y` is `preview_links.exp` — the clock, checked by `isLinkActive` on every request and rewritten by `just preview-extend` with a single `UPDATE`. `X` is the token's signed `exp`, set 30 days out at mint (`CEILING_HOURS`) and immutable because it is inside the HMAC — which is precisely why it cannot be the working expiry: moving it would mean a new URL. **The URL never changes**, so there is nothing to re-send and the reviewer never learns their link was about to lapse. `--hours` is a new window from *now*, so the same command shortens as readily as it extends. The cap is also stored as `max_exp` so the CLI can refuse an extension the worker would silently reject on arrival — that refusal looks identical to the feature being broken.

**Publication is the third bound, and usually the first to bite.** `--hours 48` on a draft going live tomorrow gets a day, and the mint output says so rather than quietly honouring less than you asked for. Only the row is capped — the **signature ceiling is deliberately left 30 days out**, and that is what makes a slipped launch recoverable: push `pubDate` back, run **`just preview-extend-all <slug> --hours N`**, and every outstanding link is re-clamped to the new date with **not one URL changed**. Clamping the ceiling too would turn every slipped date into a reminting exercise, which is the exact problem extending exists to remove. A link whose ceiling falls short of the new date is named in that command's output and exits non-zero; that one has to be reminted.

Moving `pubDate` **earlier** is the case the cap cannot see, since it is a snapshot taken at mint time — so `BlogPost.astro` and `/api/galley` both refuse the galley on a published post independently. Reading is untouched by that: the post is public, so the link opening it is no longer granting anything.

That is what makes short windows cheap: **mint the window you actually mean.** `--hours 48` for a couple of days' reading, not the default doubled "just in case", because more time no longer means a new link. Revocation still needs someone to notice a link went astray before it helps, and a shorter window is what limits the damage in the meantime.

**The roster is the only inventory that exists.** A token is recorded nowhere else, so a link missing from it cannot be revoked, only waited out. `just preview-roster <slug>` answers for one post; **`just preview-roster-all` answers for every post**, which is the one to reach for when you can't remember which draft a link was minted for — without it, a forgotten slug meant a link you could not withdraw at all. Live rows show their remaining headroom as `· extend to <date>`.

**Minting now needs D1, and this is the accepted cost.** `just preview-link` writes its row before printing the URL — a link that verifies but has no row is refused on arrival, which looks exactly like the feature being broken, so a failed insert hands out nothing at all. That means minting against production needs an API token carrying **D1:Edit**, and minting for local work needs `--local` against a migrated database. While D1 is unavailable, no preview link works. That failure is recoverable and immediately visible; links that cannot be withdrawn are neither. `npm run dev` is unaffected — it shows scheduled posts outright, so preview links were never the local mechanism.

**Everything fails closed.** No signing key, no `DB` binding, a D1 error, a missing row, a revoked row, an expired row, or an `exp` that came back as anything other than a finite number all resolve to no grant. There is deliberately no branch in this feature where a failure widens access.

**The row-expiry check is the one that can fail silently, so smoke pins it specifically.** Every other fixture row is far-future dated, so if `isLinkActive` stopped reading `exp` nothing else would go red — links would simply run to their full 30-day ceiling instead of their stated window, invisibly. `smoke.mjs` therefore seeds `ROW_EXPIRED_LINK_ID`: an un-revoked row whose `exp` has passed, under a validly signed token with a far-future ceiling, and asserts the post still 404s. Verified by fault injection — deleting the `exp` comparison fails that check and only that check.

**Neither pre-allowlist token shape verifies any more.** `<slug>.<exp>.<sig>` and `<slug>.<exp>.<reviewer>.<sig>` predate link ids and have no row to revoke, so honouring either would leave a permanent grant outside the allowlist. They were removed rather than deprecated because the galley had not shipped when this landed and no link of either shape was ever issued. Rotating `PREVIEW_SIGNING_KEY` remains the blunt instrument that invalidates everything at once.

Setup:

```sh
openssl rand -hex 32                      # generate
# → .dev.vars as PREVIEW_SIGNING_KEY (also read by scripts/preview-link.mjs)
wrangler secret put PREVIEW_SIGNING_KEY   # same value, production

wrangler d1 migrations apply mjrossi-galley --remote   # creates both tables
```

**The migrations are not optional:** until `0001` is applied, `preview_links` does not exist and *every* mint fails with "no such table" — view-only links included, not just review ones. Until `0002` is applied, `max_exp` is missing and every mint fails on the insert. The deployed worker depends on neither: it reads `exp` (which `0001` created) and enforces the ceiling from the token, so a worker can ship ahead of a migration without serving anything it shouldn't.

**`0003` is the exception to that last sentence** — it adds `galley_notes.closed_at` and drops `status`, and the worker reads the first and no longer writes the second. Apply it *before* deploying the worker that expects it, or every galley read and write fails on the missing column.

If `PREVIEW_SIGNING_KEY` is unset the worker rejects every link and only the `*.workers.dev` unlock remains — nothing else breaks.
