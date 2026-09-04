# The galley

Inline editorial review: editors open a signed link, read the real rendered post, select a passage, and leave a note. Notes come back anchored and structured, so applying them to the MDX is mechanical rather than interpretive. Named for the galley proof — the pre-publication print sent out for correction.

Split out of `CLAUDE.md`, which keeps the commands and the load-bearing invariants. **This file is the reasoning** — most of it records a bug that has already shipped once. Read it before touching `public/scripts/galley*.js`, `src/lib/galley-*.js`, `src/pages/api/galley.ts`, `src/components/GalleyMargin.astro`, or any `scripts/galley-*.mjs`.

Access is not the galley's to grant — links are minted, extended, listed and revoked with `just preview-link` / `preview-extend` / `preview-roster` / `preview-revoke`. See [PREVIEW-LINKS.md](PREVIEW-LINKS.md).

Inline editorial review. Editors open a link, read the real rendered post, select a passage, and leave a note. Notes come back anchored and structured, so applying them to the MDX is mechanical rather than interpretive. Named for the galley proof — the pre-publication print sent out for correction.

```sh
just preview-link my-draft --remote --reviewer jd   # one link per editor, mint with initials
just galley my-draft --remote                       # → docs/galley/my-draft.md
just galley-close my-draft --remote                 # after the revision merges — ends the round
```

**The galley does not hand out access.** Links are minted, listed, and revoked with `just preview-link` / `preview-roster` / `preview-revoke` — one vocabulary for who may see a draft, whether or not they may comment on it. The galley owns the notes, the margin, the anchoring, the pull, and the round lifecycle (`galley-close` / `galley-reopen`). That boundary is why there is no `galley-link`: a command that issued access from inside the galley namespace is exactly what made revoking one feel like it belonged to a different feature.

**Git holds the post. D1 holds the conversation about the post.** That split is the whole design. Notes are ephemeral, relational collaboration state (many notes × many reviewers × per revision); a post is a durable versioned artifact whose git history is worth reading. Do not migrate posts into the database — `Figure`/`diagrams/*` compile at build time, `astro:assets` optimises images at build time, and frontmatter is Zod-validated at build time. All three would have to be rebuilt at runtime, and the editorial record in commit bodies would become an `updated_at` column.

**Authorisation is the preview token, extended.** A token is `<slug>.<exp>.<linkId>.<sig>` (view-only) or `<slug>.<exp>.<reviewer>.<linkId>.<sig>` (view + comment). The signed payload is every field except the signature, so the shape is authenticated: a view-only link can't have a reviewer spliced in, a review link can't be stripped back to look like a plain one, and neither can be repointed at a different allowlist row. Reviewer is read from the token, never from the request body, so a note can't be attributed to someone who didn't write it. Editors need no account and no GitHub.

**A review link can be withdrawn, or given more time.** It is an ordinary preview link with a reviewer inside the signature, so it is recorded in `preview_links` and `just preview-revoke <slug> <id> --remote` takes it back — reading included, so the draft 404s for that link. `just preview-extend <slug> <id> --hours N --remote` goes the other way and leaves the reviewer's URL untouched, which is what a review round that ran long actually needs. `just preview-roster <slug> --remote` lists what is outstanding, and `just preview-roster-all --remote` lists every link across every post. See "Previewing a scheduled post" above for the full mechanism, the clock and its cap, the fail-closed behaviour, and the D1 dependency that minting now carries.

**Publishing closes the galley.** The review round ends when the post does: `BlogPost.astro` stops rendering the margin and `/api/galley` refuses both methods with `post_published` once `pubDate` has passed. Normally no link ever reaches those checks, because minting caps its expiry at publication — but that cap is a snapshot, and step 5 of the workflow below moves `pubDate` **earlier**, so a link outstanding from that move lands in exactly this state. Enforced in the endpoint as well as the layout, because the layout decides whether the margin is *drawn* and the endpoint decides whether a note can be *written*; a client that keeps posting after the chrome disappears has to meet the same rule. Smoke seeds `PUBLISHED_LINK_ID` — a live, un-revoked, unexpired review link on a post that is already public — and asserts the post still renders, the margin does not, and both `/api/galley` methods 403. Verified by fault injection: deleting either gate fails its own assertions and nothing else, and every other fixture points at the future-dated post, so without this one the suite would stay green through the bug.

Two things that scoping does *not* solve, and still need judgement. Mint the window you actually mean and let it run short — `just preview-extend` gives an editor more time without a new URL, so there is no longer any reason to pad the default "just in case", and a shorter window is what limits the damage while nobody has noticed a link went astray. And treat the write quota in `src/pages/api/galley.ts` as the bound in the meantime — 60 notes per reviewer per hour, asserted live in smoke.

**That quota is one SQL statement, and it has to stay one.** The count is a subquery inside the `INSERT ... SELECT ... WHERE`, and a refusal arrives as `meta.changes === 0` rather than as an error. Split back into a `SELECT COUNT(*)` followed by an `INSERT` and the bound holds only against a polite client: two round-trips let concurrent requests all read the same pre-flood count, all pass, and all insert. Smoke fires 90 notes in parallel and asserts no more than the quota lands — measured at 69 accepted against a cap of 60 with the check-then-insert version, so this is the observed behaviour and not a theoretical race.

The flood collects with `Promise.allSettled`, and the reason is worth keeping: under `Promise.all` one dropped connection rejects the whole batch, surfaces as `smoke: ERROR — fetch failed`, and takes the ~40 assertions after it down with no indication of which one mattered. `wrangler dev` drops connections under far less load than this — `fetchExpectingNon5xx` exists for exactly that. **But tolerance needs a floor under it**, which is what the `galley: the flood actually reached the endpoint` check is: `accepted <= quota` is vacuously true when nothing was accepted, so a run where the worker died mid-flood would otherwise go green on a dead endpoint. Verified by fault injection — dropping 70 of 90 requests fails the floor check while `accepted <= quota` still passes, which is precisely the false green the floor exists to convert into a red.

## What the pulled file tells you

`docs/galley/<slug>.md` is ordered by line number, which answers "what did they say about this passage?" and not "what is this round actually asking for?". Three additions answer the second question, all of them in `galley-render.js` and none of them touching the schema, the worker, or the client.

**A section label on every group heading, and a counts-by-section summary in the header.** `## Line 76-76 · Know what only you can decide`, and at the top a block naming each section with its note count. A round's shape is its clusters — seven notes on one section is a rewrite, seven notes spread over seven is an afternoon of small edits — and a file sorted by line number shows neither. Round 2 on Part 3 drew exactly that cluster and it was found only by reading all 51 notes and noticing.

**The summary buckets on the heading's line, not on its text**, which is why `sectionMap` returns `{ line, text }` rather than a string. A post can carry the same words twice — `### What worked` under Part two and again under Part three — and `SECTION_MAX` can truncate two long headings to the same string besides. Merging either pair reports one cluster of seven where the truth is four and three, which is precisely the inference the summary exists to support, so it would be wrong in the one direction that matters. Repeated words therefore print on two rows, in source order, with the line ranges on the headings below saying which is which.

**The label and the excerpt are read at the same index, and that is the invariant.** `sectionMap` builds line → heading in one forward pass (fence-aware, because a `##` inside a code block is not a heading; frontmatter skipped, because `# a comment` in YAML is not one either), but the *index* comes from the same `anchorIndex` the excerpt uses — stored anchor on an unchanged file, relocation on a drifted one. Two independently computed indices is how a heading names a different passage than the excerpt printed under it, which is `resolveGroup`'s failure mode one level up. **A stale group whose quote can't be found gets no label at all**: its stored line number means nothing in the current file, so there is nowhere honest to read a heading from. Both directions are fault-injection verified.

**`↳ same passage as above`** marks a note filed on a passage an earlier note in the same group already covered (same reviewer, same quote). This exists because a reviewer suggested `up front → upfront` and then filed "actually nvm" on the same words — a *retraction* that read exactly like an instruction, and was caught only because `listNotes` orders by `created_at` and the two happened to land adjacent. In a bigger group that adjacency is luck. The wording is deliberately neutral: the heuristic catches a retraction and a plain afterthought alike, and only the adjacency is certain. Scoped to one reviewer, because two editors on the same sentence is the ordinary case.

**Byte-identical notes print once, over one meta line per id.** A double-submit put two ids on the same reviewer, quote, body and suggestion, and the file read as two independent pieces of feedback. Collapsing is safe *only* because the manifest is line-based — `noteIdsInMarkdown` reads each meta line, so every id stays closable. **An entry whose extra ids stopped being printed would leave those notes open forever with nothing saying so**, which is why the round-trip is the assertion that matters and is fault-injection verified. The duplicate key is every content field, prefix and suffix included: the same words selected at a different occurrence in the same block are different notes, and that is the only place they differ. Collapse runs *before* the same-passage pass, or a duplicate pair would mark itself.

## A round ends when you close it

Notes used to be write-once: one `INSERT` and no `UPDATE` anywhere. Every note ever left on a post came back on every read, forever — so the pull after round 2 contained round 1 as well, flagged as drifted, and the reviewer re-opening their link saw the same pile. `migrations/0003` added `closed_at` for exactly this.

```sh
just galley my-draft --remote                    # → docs/galley/my-draft.md, ids and all
# apply, PR, squash-merge
just galley-close my-draft --remote              # the round is over
just galley my-draft --remote --all              # closed notes, when you want the record
just galley-reopen my-draft --note <id> --remote # undo a mis-close
```

**`galley-close` reads the pulled file back, and that is the whole design.** The obvious rule — "close every note written against a revision I have since replaced" — is wrong the moment a second reviewer exists. Drift is a property of the *file*, not of whether anyone has read the note: apply r1's round and merge, and every note r2 filed in the meantime drifts too. A drift-based close would retire feedback nobody has looked at, silently, and the reviewer's margin would then show it as addressed. `docs/galley/<slug>.md` is what the author actually worked through, it is committed alongside the revision that answers it, and notes filed after that pull are out of reach by construction. The command says how many it left open and **who filed them**.

Run it **after** the merge. Closing first retires notes whose fixes are not in the file yet. A row is never deleted, so a closed note stays in the record — `--all` reads it back, and `just galley-reopen` puts one back in the working set.

Smoke covers the scoping with three seeded notes (open-and-current, open-but-stale under a *second* reviewer, and closed) plus a `closeNotes`/`reopenNote` round-trip in `fixtures.mjs` — the only place `notes-db.mjs` SQL runs under test. Without those fixtures there is nothing for a regression to expose: every note the live matrix writes is open and current by construction, so dropping the `closed_at` filter would leave the suite entirely green.

## A note is refused if its page has moved

`src` is a line range the client reads from `data-src` in the HTML **it currently has loaded**, while the endpoint used to stamp the note with the hash of whatever the server held. A reviewer holding a post open across a revision therefore filed the *old* revision's anchors under the *new* revision's hash — a note that looked perfectly fresh, that the drift machinery had no reason to question, and whose line numbers pointed at prose it was never about. That is the one way a note could be silently wrong rather than visibly stale, and it is the normal case for a second reviewer.

So `BlogPost.astro` stamps the page with `data-revision`, the client echoes it on every write, and a mismatch is refused with `409 stale_page`. The client is never trusted to *say* what revision a note was written against — only to prove it is looking at the current one; the stored `revision_hash` is always the server's own. Same stance as `galley-relocate.js` resolving an ambiguous quote to nothing: refuse rather than store something that will be confidently wrong.

**It is a correctness guard, not a control.** Anything can `GET /api/galley`, read `revision`, and echo it back — the check stops an *honest* client whose tab has gone stale, which is the entire bug, and it should not be leaned on for anything more. What makes it sufficient is that the reviewer is already authenticated by the signed link.

The reviewer's typed text survives in the composer (the error path returns before `closeComposer()`), which is why the message says to **copy it** before reloading — the selection cannot be restored afterwards.

## The margin never points at the wrong passage

`markAnchors` is a literal `[data-src="42-47"]` lookup with no quote fallback, so once the source has changed those line numbers either match nothing or — worse — match whichever block has since moved into that range. Two independent gates now stop it: `note.stale` (this page is current, that note predates it) and a page-level check comparing the GET's `revision` against `data-revision` (the server is ahead of this whole document, so *every* anchor here is suspect, including notes the server considers current). A stale note renders with an `earlier revision` chip in place of its line number; a stale page raises a reload prompt in the bar and withholds all markers.

**Both gates live in `public/scripts/galley.js` and nothing tests them.** Smoke pins the server side — that `stale` is set on the right notes and that the page's `data-revision` matches the GET's `revision` — which is a *proxy* for this fix, not the fix itself: delete either `return` in `markAnchors` and the whole suite stays green. There is still no browser harness here, so treat `markAnchors` as code to re-read by hand when touching it — and **run `just galley-preview`**, which renders every marker case in about a second and is where a broken gate actually shows up.

**Each gate has its own preview invocation, and you need both.** The default run covers `note.stale` (one fixture note carries it). It cannot cover the page-level gate — the stub's `revision` and the mount's `data-revision` agree by construction, so `pageStale` is permanently false and deleting `if (pageStale) return;` changes nothing on screen. **`just galley-preview --stale`** desyncs them: expect no markers anywhere, no highlights, the reload prompt in the bar, and a save refused with the `stale_page` message. Running only the default is how that gate gets deleted without anyone noticing.

**What is and is not covered, so the gap is known rather than assumed.** Everything that *decides* an anchor or a marker is pure and unit-tested in `galley-quote.js` — including the round trip between the two directions. What is left in `galley.js` is the part that needs a document: which block a selection is in, how much text it covers, where it starts, gathering text nodes, building a `Range`. That split was made deliberately, because the write side is what lands in D1 permanently and it could not be tested while it lived in a closure over `window.getSelection()`. The residue is thin but real, and `just galley-preview` is the answer to it rather than a test runner.

## Every note gets exactly one marker, and which one says how precisely it was placed

Past those gates, `markAnchors` marks each current note one of two ways:

- **The quoted words**, when `findQuote` (`public/scripts/galley-quote.js`) can locate the note's quote in the block unambiguously. Painted through the **CSS Custom Highlight API** — a `Range` styled by `::highlight(galley-note)`, with no element and no DOM mutation. That is what makes word-level marking safe here: wrapping the words in a `<mark>` would mutate the very tree `resolveSelection` measures offsets against and `markAnchors` re-reads on every refresh, so each render would have to unpick its own previous one and any slip would corrupt an anchor rather than just a colour.
- **The whole block**, otherwise — no quote stored, quote not found, the quote occurs twice in that block, or a browser without the Highlight API (Firefox below 140). `data-galley-count` counts *these* notes only, so the number describes what the block marker actually stands for.

**A single occurrence is the reviewer's occurrence, not a probable match — and that is only true because of the gates above.** A marker is placed solely for a note the server considers current on a page that is itself current, which means the `.mdx` has not changed, which means the block's rendered text is the text `anchorSelection` measured against when the note was filed. So if `findQuote` finds exactly one occurrence, it is provably the one selected. This is what licenses matching on quote text at all — the read side never disambiguates, it only confirms. **Do not add a quote fallback for stale notes.** It looks like a free improvement (a stale note's line numbers are dead, but its quote might still be findable) and it silently destroys this property: on changed source, one occurrence is merely the only *remaining* one, which is a different claim entirely and is how a note lands on prose it was never about. Relocating a stale note is the pull side's job, where `galley-relocate.js` has the prefix/suffix to do it honestly.

**An ambiguous quote resolves to nothing rather than to a guess**, exactly as `galley-relocate.js` does on the pull side. A note stores prefix/suffix for this case but `GET /api/galley` does not return them, so when a paragraph says "note" twice there is no way to tell which was meant — and the block marker still tells the reviewer there is a note here, just not which words.

**The block marker is a flat wash across the whole element, and that is load-bearing.** It was `linear-gradient(transparent 60%, var(--accent-band) 60%)` — the inline highlighter-pen idiom, which resolves against a *line* box on an inline element but against the whole *paragraph* box here, because the client marks blocks. The result was a solid band over the last 40% of every marked paragraph: a confident pointer at whatever prose happened to fall there, never the prose the note was about, and on a one-line block a bar floating below the text entirely. Anything with an edge inside the block re-creates that bug. If the marker is going to mean "somewhere in this block", it has to cover the block.

## More than one reviewer

- **They see each other's notes.** `GET /api/galley` scopes a read to the slug and never to the token's own reviewer, because an editor who cannot see a colleague's note re-files it. They also cannot exhaust each other's write quota, which *is* per-reviewer. Smoke pins the cross-reviewer read with two labels.
- **One pull covers everyone.** `just galley <slug>` writes every reviewer's notes into one file grouped by anchor, so two people's notes on the same paragraph sit together — which is what you want when they disagree. Apply all, one PR, one merge, one close.
- **The margin refreshes on tab focus** (throttled), because `load()` otherwise ran only at startup and after this reviewer's own save — so a colleague's note filed in the meantime never appeared. No polling: an idle tab costs nothing.
- **Pull last, close after merge.** Anything filed in between stays open and is named.
- **Don't merge mid-round.** A reviewer still working through the old revision has every note they have already filed go stale — flagged and quote-relocatable, but their line numbers are dead — and anything they save from that open tab is refused until they reload. Visible rather than silently wrong, but still disruptive; pull again afterwards.

**The token rides in a URL, so `Referrer-Policy` is load-bearing.** A draft under review links outward like any other post, and `strict-origin-when-cross-origin` (from `src/lib/security-headers.js`) is what keeps `?preview=…` out of third-party referer logs. Relaxing that header to `unsafe-url` would hand every outstanding review link to every site a draft links to, silently and with nothing else in the system noticing.

**Anchoring is two-part, and both parts are load-bearing.** `remark-source-anchors` stamps `data-src="<start>-<end>"` on each block; the client records that range *plus* the quoted text and ~32 characters either side. The line range is exact but goes stale on the next revision — which is the normal case, since review happens in rounds. The quote survives revision but is ambiguous alone. Each note also stores a SHA-256 of the **whole .mdx file, frontmatter included** — anchors are absolute line numbers, so adding one tag shifts every one of them, and a body-only hash would call that "unchanged".

`galley-pull.mjs` compares that hash against the file and, where the quote is still findable, reports `now line N` with the current text. Where it isn't, it says so rather than printing a line number pointing at unrelated prose. Ambiguous matches deliberately resolve to nothing — confidently naming one of three identical sentences is how a note gets applied in the wrong section.

**Typography must be folded before searching.** Smartypants renders `'` as `’` and `--` as an em dash, so an editor's selection never matches the source byte-for-byte. `galley-relocate.js` folds both sides; without it every note would look like it had drifted.

**Inline markdown must be stripped from the source side, and only from the source side.** A quote comes from `block.textContent`, which carries no markup at all, while the search runs against raw `.mdx` — so a selection spanning a link, emphasis, or a code span is not a substring of the line holding it (`we shipped [the Atlas](…) last spring` vs `we shipped the Atlas last spring`). Every post here has inline links and editors select whole sentences, so without `unmark` the quote half of the anchor is dead exactly when the line range has gone stale and it is the only half left. One-directional on purpose: folding the quote side would mean guessing at markup the client already discarded, and a wrong guess produces a confident match on the *wrong* passage, whereas over-stripping the source merely fails to match — which is already reported safely.

**`data-src` ships on every block of every published post, not just drafts under review.** `remark-source-anchors` runs at build time, where there is no request to condition on — the alternative is a second build of the whole content collection, which is not worth it. The cost is ~15 bytes per block and the disclosure that a post's paragraphs occupy given MDX line numbers, which is public in this repo anyway. Worth knowing before treating a `data-src` in production HTML as a bug.

**Scope is unchanged from a read-only link.** A review link grants *writing*, not *reach*: still one post, still not `/blog`, still not tag pages, and above all still not `/blog/rss.xml` — the feed is what triggers Buttondown's irreversible send. `previewReviewer` must never reach `src/lib/blog.ts` or the RSS route; smoke greps for exactly that and separately proves it live.

**The second JS carve-out is tighter than the first.** `galley.js` loads only when `previewReviewer` is set *and* `previewSlug` matches the post being rendered — which is only ever true on a response middleware has already forced to `no-store` + `noindex`. It is structurally incapable of reaching a publicly cacheable page, where `newsletter.js` ships on every `/blog` hit. Don't loosen that gate in `BlogPost.astro`. `galley-quote.js` inherits the gate rather than needing its own: nothing imports it but `galley.js`, so it is fetched only once that has already loaded. Keep it that way — a second `<script src>` in the component would be a second thing to gate.

**The CSS does not inherit that gate for free, and this bit is easy to get wrong.** Astro hoists a processed `<style>` into the *route's* stylesheet from the static module graph, not from the runtime condition that renders the component — so a plain `<style>` in `GalleyMargin.astro` ships every `.galley-*` rule as a render-blocking stylesheet on every published post, invisibly, with no galley markup in the HTML to give it away. The block is therefore `is:inline`, which also happens to be the only way it works at all: scoped styles compile to `.galley-bar[data-astro-cid-…]`, and every element they target is created at runtime by `galley.js` via `createElement`, so it never carries the attribute. `smoke.mjs` asserts both directions — no `galley-` in the built CSS bundles, and no `galley-` in a published post's HTML.

**No admin *write* surface, and reads are gated separately.** Notes are pulled with `wrangler d1 execute`, which is already authenticated as you. `/api/galley` still has no way to list notes across posts — a signed review link grants one post, and handing someone one draft must not hand them the rest. The Desk at `/admin` does read across posts, which is a real widening; it sits behind Cloudflare Access rather than behind a preview token, and it cannot write anything. See "The Desk" below.

Setup, once:

```sh
wrangler d1 migrations apply mjrossi-galley --remote
```

**The API token needs D1 permissions.** This was a real failure once and is worth recognising if it recurs, but the token in `mise.local.toml` has D1 today — `wrangler d1 info mjrossi-galley` and `just galley <slug> --remote` both work.

`CLOUDFLARE_API_TOKEN` is set in the shell and wrangler prefers it over an OAuth login. If that token lacks D1, every `--remote` D1 command fails with:

```
The given account is not valid or is not authorized to access this service [code: 7403]
```

That is a token-scope problem, not a wrangler or account problem — the account is correct and `wrangler whoami` will happily list it. Fix by adding **D1:Edit** to the token at <https://dash.cloudflare.com/profile/api-tokens>, or by unsetting `CLOUDFLARE_API_TOKEN` and using `wrangler login`. Until then `just galley <slug> --local` is the only one that works; the deployed worker is unaffected, since it reaches D1 through its binding rather than the API.

Smoke migrates the local database itself — `wrangler dev` does not apply migrations on startup, and without that step the galley assertions fail with "no such table", which reads like a broken endpoint rather than an unmigrated fixture.

## Trying the galley locally

**If all you need is to see the margin, use `just galley-preview`.** It serves the real client and the real stylesheet against fixture prose on `127.0.0.1:8790` — every marker case, the panel, and a working composer — with no build, no worker, no D1 and no link to mint. That is the loop for anything visual, and the one to reach for before believing a change to `GalleyMargin.astro` or `markAnchors`. `--shot FILE` writes a PNG if you have a headless Chrome.

The full loop below is for everything else — authorisation, the endpoint, the database, the pull. It runs on your machine against the local D1 that `just preview` and `just smoke` share. `npm run dev` is **not** the way in — it runs Astro alone, with no worker, no `/api/*`, and no database, so the margin cannot save anything. Use `just preview`.

```sh
just galley-migrate --local                  # once, and after any new migration
just preview                                 # build + wrangler dev on 127.0.0.1:8788

# in another shell — any post works, published or scheduled
just preview-link smoke-scheduled-fixture --local \
  --host http://127.0.0.1:8788 --reviewer jd
# → http://127.0.0.1:8788/blog/smoke-scheduled-fixture/?preview=…

# open that URL, select a sentence, leave a note, then:
just galley smoke-scheduled-fixture --local  # → docs/galley/<slug>.md, with note ids
just galley-close smoke-scheduled-fixture --local     # end the round
just galley smoke-scheduled-fixture --local --all     # closed notes back again
just preview-roster-all --local              # what you have minted locally
just preview-extend smoke-scheduled-fixture <id> --local --hours 96   # same URL, more time
just preview-extend-all smoke-scheduled-fixture --local --hours 120   # after moving pubDate
```

`smoke-scheduled-fixture` is the permanently future-dated fixture post, which makes it the natural target: it exercises the scheduled-post path as well as the galley, and it 404s without a token exactly as a real draft does. A **published** post still mints (the clamp is skipped, and the mint output says the post is already live), but its link cannot be extended and the galley will not open on it — so use the fixture for the whole loop.

Three things that will otherwise cost you time:

- **The port is 8788, and it is pinned for this reason.** `just preview` sets `--port 8788` (in `package.json`) rather than taking wrangler's default, so it matches `just smoke` and the `--host` above is the same in both. A link minted for one port simply 404s on the other — the host is inside the URL, not the signature, so nothing warns you.
- **`--local` is required, and it must match on both ends.** Minting writes the allowlist row; pulling reads the notes. Point either at the wrong database and you get a link refused on arrival, or "no notes" for a post that has them. Both messages now name the database they used, which is the fastest way to spot it.
- **Clean up after yourself if you used a real slug.** Local notes and links persist in `.wrangler/state` between runs. `just smoke` only clears its own fixture rows (`preview_links` for the fixture slug, and `galley_notes` for its own reviewer label), so a stray note left under another reviewer on the fixture post can skew smoke's counts. Delete it, or use a throwaway slug.

## The authoring workflow this implies

**Branch preview URLs cannot be used for review.** `*.workers.dev` hosts sit behind Cloudflare Access, so an editor without a service token gets a login page instead of the post. Review therefore happens through signed links on `mjrossi.com`, which means the draft must already be on `main` with a future `pubDate`. Long-lived draft branches are incompatible with this feature.

1. Draft on a branch until it's a structurally complete first draft. Messy commits are fine — `main` is squash-only, so they never land.
2. PR → squash-merge to `main` with a future `pubDate` (~3 weeks out). One commit; hidden on every surface.
3. `just preview-link my-draft --remote --reviewer <initials>` per editor.
4. `just galley my-draft --remote` → apply → **one revision PR per review round** → merge → `just galley-close my-draft --remote`. Close last: it retires the notes listed in the pulled file, and running it before the merge would retire notes whose fixes are not in the file yet. If another reviewer is still going, the close names what it left open — pull again rather than closing twice.
5. Set `pubDate` to the real date. **If you moved it later, run `just preview-extend-all my-draft --hours N --remote`** — outstanding links are still capped at the old date and would lapse mid-review, and this re-clamps them without changing a URL. If you moved it earlier, there is nothing to do: the links simply end sooner, and the galley closes on its own.

`main` gets ~2–4 commits per post. That is deliberate: the revision commits carry the editorial reasoning, and squashing them into the original post commit would destroy the most useful part of the history.

Accept knowingly: from step 2 the post exists in production storage. Every surface hides it, but its cover image is fetchable at an unguessable hashed `_astro/` URL — don't schedule a post whose cover image is itself the announcement.

