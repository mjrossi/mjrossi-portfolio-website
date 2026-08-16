// "Can a draft leak" — the other half of the live suite.
//
// The source greps in static.mjs prove previewSlug never reaches blog.ts or the
// RSS route, but a leak introduced in index.astro or tag/[tag].astro would slip
// past every one of them. These matrices close that gap against a real
// future-dated post, over HTTP, on the production code path (127.0.0.1 is
// deliberately not a preview host).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { signPreviewToken, WORKER_NAME } from '../../src/lib/preview.js';
import { check, checkHeader, checkStatus } from './check.mjs';
import {
  BASE,
  FAR_FUTURE_EXP,
  FIXTURE_REVISION,
  FIXTURE_SLUG,
  FIXTURE_TAG,
  GALLEY_WRITE_QUOTA,
  NOW_SEC,
  OTHER_SLUG,
  PORT,
  PREVIEW_KEY,
  PUBLISHED_SLUG,
  SMOKE_REVIEWER,
  STALE_REVISION,
} from './config.mjs';
import { LINKS, NOTES, UNRECORDED_LINK_ID } from './fixtures.mjs';

/** Sign a grant with the key the worker will actually hold. */
const mint = (grant) => signPreviewToken(grant, PREVIEW_KEY);

/** A URL for `path` carrying `token` as its preview query. */
const withToken = (path, token) => `${BASE}${path}?preview=${encodeURIComponent(token)}`;

/**
 * The three listing surfaces a leak would show up on, fetched together.
 *
 * RSS is the one that matters most — it drives Buttondown's email to real
 * subscribers, so a link handed to a reviewer reaching it would publish the
 * post for real.
 */
async function fetchListings(token) {
  const q = token ? `?preview=${encodeURIComponent(token)}` : '';
  const [index, rss, tag] = await Promise.all([
    fetch(`${BASE}/blog${q}`).then((r) => r.text()),
    fetch(`${BASE}/blog/rss.xml${q}`).then((r) => r.text()),
    fetch(`${BASE}/blog/tag/${FIXTURE_TAG}${q}`),
  ]);
  return { index, rss, tag };
}

// `revision` is required on every write: the endpoint refuses a note whose page
// has moved under it (409 stale_page), so the happy paths have to carry the real
// hash of the fixture post. checkRounds asserts the negative direction.
const NOTE_BODY = {
  slug: FIXTURE_SLUG, kind: 'comment', src: '8-8', quote: 'test fixture', body: 'smoke note',
  revision: FIXTURE_REVISION,
};

const postNote = (token, body = NOTE_BODY) =>
  fetch(`${BASE}/api/galley${token ? `?preview=${encodeURIComponent(token)}` : ''}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * @param {{ post: { html: string } | null }} routes the published post fetched
 *   by checkRoutes, reused here for the "galley absent from a published post"
 *   guard rather than fetched twice.
 */
export async function checkPreviewAndGalley({ post }) {
  await checkFailsClosed();
  const fixtureExp = NOW_SEC + 3600;
  const viewToken = await checkScheduledMatrix(fixtureExp);
  await checkGalleyMatrix(fixtureExp, viewToken, post);
}

/**
 * The unlock must fail closed. 127.0.0.1 is not a preview host (deliberate — it
 * keeps every other assertion on the production code path), and no key can
 * produce these signatures, so a garbage token must change nothing at all. If
 * either guard regressed, the response would flip to no-store and start
 * carrying X-Robots-Tag.
 */
async function checkFailsClosed() {
  const bogus = await fetch(`${BASE}/blog?preview=some-draft.9999999999.deadbeef`);
  const bogusHtml = await bogus.text();
  checkStatus('preview: invalid token still 200', bogus, 200);
  checkHeader('preview: invalid token does not disable caching', bogus, 'cache-control', 'max-age=3600');
  check(
    'preview: invalid token reveals no scheduled post',
    !bogusHtml.includes('post-scheduled'),
    'a Scheduled badge rendered for an unsigned token',
  );
  // A malformed token must not 500 the route either — verifyPreviewToken
  // swallows every parse failure and returns null.
  const malformed = await fetch(`${BASE}/blog?preview=%2E%2E%2F..%2Fetc`);
  checkStatus('preview: malformed token does not error', malformed, 200);
}

/** @returns the view-only token, reused by the galley matrix. */
async function checkScheduledMatrix(fixtureExp) {
  const viewToken = await mint({ slug: FIXTURE_SLUG, exp: fixtureExp, linkId: LINKS.view.id });

  // 1. Locked: hidden everywhere, 404 at its own URL.
  const [locked, lockedPost] = await Promise.all([
    fetchListings(null),
    fetch(`${BASE}/blog/${FIXTURE_SLUG}/`),
  ]);
  check('scheduled: fixture absent from /blog', !locked.index.includes(FIXTURE_SLUG));
  check('scheduled: fixture absent from RSS', !locked.rss.includes(FIXTURE_SLUG));
  checkStatus('scheduled: fixture URL 404s', lockedPost, 404);
  // getAllTags only sees published posts, so the tag page must not exist.
  checkStatus('scheduled: fixture-only tag page 404s', locked.tag, 404);

  // 2. Unlocked with a valid token — the post's OWN url only.
  const unlocked = await fetch(withToken(`/blog/${FIXTURE_SLUG}/`, viewToken));
  const unlockedHtml = await unlocked.text();
  checkStatus('preview: valid token opens the scheduled post', unlocked, 200);
  check('preview: unlocked post shows the Scheduled badge', unlockedHtml.includes('post-scheduled'));
  checkHeader('preview: unlocked post is no-store', unlocked, 'cache-control', 'no-store');
  checkHeader('preview: unlocked post is noindex', unlocked, 'x-robots-tag', 'noindex');

  // 3. THE load-bearing direction: that same valid token must not widen the
  // listing surfaces.
  const opened = await fetchListings(viewToken);
  check(
    'preview: valid token does NOT add the post to /blog',
    !opened.index.includes(FIXTURE_SLUG),
    'a signed preview link widened the blog index',
  );
  check(
    'preview: valid token does NOT add the post to RSS',
    !opened.rss.includes(FIXTURE_SLUG),
    'a signed preview link reached the feed — this would trigger the subscriber email',
  );
  checkStatus(
    'preview: valid token does NOT create the fixture-only tag page',
    opened.tag, 404, 'a signed preview link widened a tag listing',
  );

  // 4. A token minted for one slug must not open a DIFFERENT post's URL.
  // The slug is inside the signed payload, and [...slug].astro compares
  // previewSlug to the post it is rendering — this asserts that comparison
  // over HTTP. src/lib/preview.test.js covers slug *tampering* (which breaks
  // the signature); this covers the case the signature can't catch on its own,
  // a perfectly valid token presented at the wrong URL.
  //
  // Deliberately NOT written as "valid token, some already-published post,
  // expect 200": that passes with or without a token, so it can never fail
  // for the reason it claims to test.
  const wrongSlugToken = await mint({ slug: OTHER_SLUG, exp: fixtureExp, linkId: LINKS.wrongSlug.id });
  const wrongSlug = await fetch(withToken(`/blog/${FIXTURE_SLUG}/`, wrongSlugToken));
  checkStatus(
    'preview: a token minted for another slug does not open the fixture',
    wrongSlug, 404, 'a signed token unlocked a post it was not minted for',
  );

  // The two expiries, from both ends. First the CEILING half — the exp inside
  // the signature, which nothing can move.
  const expiredToken = await mint({
    slug: FIXTURE_SLUG, exp: NOW_SEC - 60, linkId: LINKS.expiredToken.id,
  });
  const expired = await fetch(withToken(`/blog/${FIXTURE_SLUG}/`, expiredToken));
  checkStatus('preview: expired token 404s the scheduled post', expired, 404);

  // Then the ROW half, and the one that actually decides when a link dies: this
  // token is signed, unexpired, and points at an un-revoked row whose own `exp`
  // has passed. Since migrations/0002 the row is the effective expiry — the
  // thing `just preview-extend` moves — and the token's exp is only the ceiling
  // above it, deliberately far out. So if isLinkActive stops reading `exp`,
  // every link quietly runs to its full 30-day ceiling instead of its stated
  // window, and this is the only assertion anywhere that goes red.
  const rowExpiredToken = await mint({
    slug: FIXTURE_SLUG, exp: FAR_FUTURE_EXP, linkId: LINKS.expiredRow.id,
  });
  const rowExpired = await fetch(withToken(`/blog/${FIXTURE_SLUG}/`, rowExpiredToken));
  checkStatus(
    'preview: an expired ROW 404s even with a valid token',
    rowExpired, 404,
    "the allowlist row's expiry is not being enforced, so every link lives to its signed ceiling",
  );

  return viewToken;
}

/**
 * Everything above tests a READ-ONLY preview link. A galley link grants strictly
 * more — the right to write — so it gets its own matrix. The point of most of
 * these is that granting more never widens the SCOPE: a review link is still one
 * post, still not the index, and above all still not the feed.
 */
async function checkGalleyMatrix(fixtureExp, viewToken, post) {
  const galleyToken = await mint({
    slug: FIXTURE_SLUG, exp: fixtureExp, reviewer: SMOKE_REVIEWER, linkId: LINKS.review.id,
  });
  const galleyApi = withToken('/api/galley', galleyToken);

  // 1. The chrome ships only where it is allowed to.
  const galleyPost = await fetch(withToken(`/blog/${FIXTURE_SLUG}/`, galleyToken));
  const galleyHtml = await galleyPost.text();
  checkStatus('galley: review link opens the post', galleyPost, 200);
  check('galley: review link loads /scripts/galley.js', galleyHtml.includes('/scripts/galley.js'));
  checkHeader('galley: reviewed page is never cached', galleyPost, 'cache-control', 'no-store');
  checkHeader('galley: reviewed page is noindex', galleyPost, 'x-robots-tag', 'noindex');

  // A READ-ONLY token must not ship the review chrome. This is the difference
  // between the two token shapes, over HTTP.
  const viewOnlyHtml = await fetch(withToken(`/blog/${FIXTURE_SLUG}/`, viewToken)).then((r) => r.text());
  check(
    'galley: a view-only preview link does NOT load galley.js',
    !viewOnlyHtml.includes('/scripts/galley.js'),
    'the galley shipped for a link that never granted review rights',
  );

  // The second carve-out must stay off every public page. /blog is the one
  // that already carries client JS, which is exactly why it is worth pinning.
  const [homeGalley, blogGalley] = await Promise.all([
    fetch(`${BASE}/`).then((r) => r.text()),
    fetch(`${BASE}/blog`).then((r) => r.text()),
  ]);
  check('galley: absent from the home page', !homeGalley.includes('/scripts/galley.js'));
  check('galley: absent from /blog', !blogGalley.includes('/scripts/galley.js'));
  // A PUBLISHED post is the page the carve-out is really about: it renders the
  // same route and the same layout as a review session, differing only by the
  // gate in BlogPost.astro. Assert on `galley-` rather than the script src so
  // this also catches styles or markup leaking without the client JS — the
  // exact shape the inline-style fix in GalleyMargin.astro exists to prevent.
  if (post) {
    check(
      'galley: absent from a published post',
      !post.html.includes('galley-'),
      'galley chrome reached a page any reader can load — and one that IS edge-cached',
    );
  }

  // 2. Writing requires a reviewer token, not merely a valid one.
  const wrote = await postNote(galleyToken);
  checkStatus('galley: a reviewer token can leave a note', wrote, 200);

  const viewOnlyWrite = await postNote(viewToken);
  checkStatus(
    'galley: a view-only token CANNOT leave a note',
    viewOnlyWrite, 403, 'reading a draft must not imply writing to it',
  );

  const anonWrite = await postNote(null);
  checkStatus('galley: an untokened POST is refused', anonWrite, 403);

  // A perfectly valid signature for a DIFFERENT post must not file a note
  // against this one — the case a signature check alone cannot catch.
  const otherGalleyToken = await mint({
    slug: OTHER_SLUG, exp: fixtureExp, reviewer: SMOKE_REVIEWER, linkId: LINKS.crossSlug.id,
  });
  const crossWrite = await postNote(otherGalleyToken);
  checkStatus(
    'galley: a token for another slug cannot write to the fixture',
    crossWrite, 403, 'a valid token wrote to a post it was not minted for',
  );

  // 3. Read-back works, and is scoped the same way.
  const listed = await fetch(galleyApi);
  const listedJson = await listed.json().catch(() => ({}));
  checkStatus('galley: notes read back for the granted post', listed, 200);
  check(
    'galley: the note just written is in the list',
    Array.isArray(listedJson.notes) && listedJson.notes.some((n) => n.body === 'smoke note'),
  );
  // Scoped to the note this token just WROTE, not to every note in the list.
  // Reviewer comes from the signed token and never from the request body, which
  // is a property of the write — and the list deliberately carries other
  // reviewers' notes, because /api/galley shares a post's notes across everyone
  // reviewing it. Asserting `every` here would make cross-reviewer visibility
  // fail as though it were an attribution bug.
  check(
    'galley: the note is attributed to the token’s reviewer',
    Array.isArray(listedJson.notes) &&
      listedJson.notes.filter((n) => n.body === 'smoke note').every((n) => n.reviewer === SMOKE_REVIEWER),
    'a note was attributed to someone other than the signed reviewer',
  );
  const viewOnlyRead = await fetch(withToken('/api/galley', viewToken));
  checkStatus('galley: a view-only token cannot read notes', viewOnlyRead, 403);

  // 4. THE ONE THAT MATTERS MOST. A review link grants writing; it must still
  // not put the draft anywhere a reader — or Buttondown's poller — can find it.
  const reviewed = await fetchListings(galleyToken);
  check(
    'galley: a review link does NOT add the post to /blog',
    !reviewed.index.includes(FIXTURE_SLUG),
    'a galley link reached the blog index',
  );
  check(
    'galley: a review link does NOT add the post to RSS',
    !reviewed.rss.includes(FIXTURE_SLUG),
    'a galley link reached the feed — this would trigger the subscriber email',
  );
  checkStatus(
    'galley: a review link does NOT create the fixture-only tag page',
    reviewed.tag, 404, 'a galley link widened a tag listing',
  );

  await checkPublishedLink();
  await checkValidation(galleyToken, galleyApi);
  // Before the quota flood by convention rather than by necessity: both writes
  // this phase makes are stale-page probes refused 409, which happens before the
  // INSERT and therefore before the quota subquery is evaluated at all. It
  // consumes none of the hour's allowance and would survive running after the
  // flood. Kept here because every OTHER write-carrying phase does have to
  // precede it, and one exception sitting on the far side would read as an
  // oversight rather than as a fact about where 409 is raised.
  await checkRounds(galleyToken, galleyApi, galleyHtml);
  await checkAllowlist(fixtureExp);
  await checkWriteQuota(galleyToken);
  checkAnchoring(galleyHtml);
}

/**
 * 4b. PUBLICATION ENDS THE GRANT. A valid, un-revoked, unexpired review link
 * whose post is already public.
 *
 * Minting normally makes this unreachable — `just preview-link` caps the row's
 * expiry at pubDate — but that cap is a snapshot taken at mint time, and the
 * authoring workflow moves pubDate EARLIER at step 5. So this is a state a real
 * link genuinely lands in, and nothing else in this file is in it: every other
 * fixture points at the future-dated post, so if both gates were deleted the
 * suite would stay green.
 */
async function checkPublishedLink() {
  const publishedToken = await mint({
    slug: PUBLISHED_SLUG, exp: FAR_FUTURE_EXP, reviewer: SMOKE_REVIEWER, linkId: LINKS.published.id,
  });

  const publishedPage = await fetch(withToken(`/blog/${PUBLISHED_SLUG}/`, publishedToken));
  const publishedHtml = await publishedPage.text();
  checkStatus(
    'published: the post still renders for a spent review link',
    publishedPage, 200, 'the post is public; the token must not take that away',
  );
  check(
    'published: a spent review link does NOT render the galley margin',
    !publishedHtml.includes('/scripts/galley.js') && !publishedHtml.includes('galley-'),
    'the review chrome is open over a post that has already shipped',
  );

  // The gate above is a render condition; this is the one that decides whether a
  // note can be written. A client that keeps posting after the chrome vanishes,
  // or one driven by hand, has to meet the same rule.
  const publishedWrite = await postNote(publishedToken, {
    slug: PUBLISHED_SLUG, kind: 'comment', body: 'smoke note on a published post',
  });
  checkStatus(
    'published: /api/galley refuses a note on a published post',
    publishedWrite, 403, 'the endpoint accepted a note for a post that is already live',
  );
  const publishedRead = await fetch(withToken('/api/galley', publishedToken));
  checkStatus('published: /api/galley refuses to list notes for a published post', publishedRead, 403);
}

/**
 * 5. Validation is actually wired to the endpoint. src/lib/galley.test.js covers
 * the rules themselves; this only proves they are being consulted.
 */
async function checkValidation(galleyToken, galleyApi) {
  const emptyNote = await postNote(galleyToken, { slug: FIXTURE_SLUG, kind: 'comment', body: '  ' });
  checkStatus('galley: an empty note is rejected', emptyNote, 400);
  const hugeNote = await postNote(galleyToken, {
    slug: FIXTURE_SLUG, kind: 'comment', body: 'x'.repeat(5000),
  });
  checkStatus('galley: an oversize note is rejected', hugeNote, 400);

  // The second note kind. `suggestion` has always been in the schema, the
  // validator and the pull script, but nothing could create one until the
  // composer grew an optional replacement field — so this is the first thing
  // that proves the kind works end to end rather than only in unit tests.
  const suggested = await postNote(galleyToken, {
    slug: FIXTURE_SLUG, kind: 'suggestion', src: '8-8',
    quote: 'test fixture', suggestion: 'a proposed rewrite',
    revision: FIXTURE_REVISION,
  });
  checkStatus('galley: a suggestion note is accepted', suggested, 200);
  const afterSuggestion = await fetch(galleyApi).then((r) => r.json()).catch(() => ({}));
  check(
    'galley: the suggestion reads back with its replacement text',
    Array.isArray(afterSuggestion.notes) &&
      afterSuggestion.notes.some((n) => n.kind === 'suggestion' && n.suggestion === 'a proposed rewrite'),
    'a suggestion round-tripped without the text that is its whole content',
  );
  // `status` no longer exists at all — migrations/0003 dropped it in favour of
  // closed_at. `revision_hash` does exist, and is deliberately folded into the
  // `stale` boolean rather than shipped: the client has no use for a hash, and
  // re-adding either is a one-word change that puts something meaningless back
  // in front of a client author.
  check(
    'galley: notes carry neither status nor the raw revision hash',
    Array.isArray(afterSuggestion.notes) &&
      afterSuggestion.notes.every((n) => !('status' in n) && !('revision_hash' in n)),
  );
}

/**
 * 5b. THE REVIEW ROUND. Notes belong to a round, a round ends when the author
 * closes it, and a note written against a revision the file no longer holds must
 * never be presented as if it described this page.
 *
 * Three fixture notes seeded in fixtures.mjs cover the three states: open and
 * current, open but stale (under a SECOND reviewer), and closed. Without them
 * there is nothing for a regression to expose — every note the live matrix
 * writes is open and current by construction, so dropping the closed_at filter
 * or the stale flag would leave the suite entirely green.
 *
 * @param {string} galleyToken
 * @param {string} galleyApi
 * @param {string} galleyHtml the reviewed page, already fetched
 */
async function checkRounds(galleyToken, galleyApi, galleyHtml) {
  const data = await fetch(galleyApi).then((r) => r.json()).catch(() => ({}));
  const open = Array.isArray(data.notes) ? data.notes : [];
  const closed = Array.isArray(data.closed) ? data.closed : [];
  const byId = (list, id) => list.find((n) => n.id === id);

  // A closed round leaves the working set but stays readable.
  check(
    'rounds: a closed note is not among the open notes',
    !byId(open, NOTES.closed.id),
    'a note from a finished round came back as outstanding',
  );
  check(
    'rounds: a closed note is still readable under "addressed"',
    Boolean(byId(closed, NOTES.closed.id)),
    'a closed note vanished — a second reviewer cannot see the point was already raised',
  );

  // Drift, flagged per note. This is what withholds the in-body marker.
  check(
    'rounds: a note against the current revision is not stale',
    byId(open, NOTES.current.id)?.stale === false,
    'a current note was flagged stale — its marker will be withheld for no reason',
  );
  check(
    'rounds: a note against an older revision IS stale',
    byId(open, NOTES.stale.id)?.stale === true,
    'a stale note was flagged current — the margin will anchor it to whatever now ' +
      'occupies those lines, which is the wrong-passage bug',
  );

  // Cross-reviewer visibility: one token, both reviewers' notes. Asserted rather
  // than assumed, because /api/galley scopes reads by slug and NOT by reviewer,
  // and a well-meant "scope it to the token" would silently break concurrent
  // review with every other assertion still passing.
  check(
    'rounds: one reviewer’s token reads another reviewer’s note',
    Boolean(byId(open, NOTES.stale.id)) && NOTES.stale.reviewer !== SMOKE_REVIEWER,
    'notes stopped being shared across reviewers — editors will re-file each other’s feedback',
  );

  // The three-way tie the stale_page check rests on: the hash on disk, the hash
  // the page was stamped with, and the hash the endpoint reports. If these can
  // drift apart, the client either refuses every write or detects nothing.
  check(
    'rounds: the endpoint reports the revision on disk',
    data.revision === FIXTURE_REVISION,
    `got ${JSON.stringify(data.revision)}, expected ${FIXTURE_REVISION}`,
  );
  check(
    'rounds: the page is stamped with the same revision',
    galleyHtml.includes(`data-revision="${FIXTURE_REVISION}"`),
    'BlogPost.astro and /api/galley disagree about the current revision — every ' +
      'note would be refused as stale_page',
  );

  // The negative direction. A reviewer whose page moved under them must be
  // refused rather than have their old anchors stored against the new revision.
  const stalePage = await postNote(galleyToken, { ...NOTE_BODY, revision: STALE_REVISION });
  checkStatus('rounds: a note from a stale page is refused', stalePage, 409);
  const staleBody = await stalePage.json().catch(() => ({}));
  check(
    'rounds: the refusal names stale_page',
    staleBody.error === 'stale_page',
    `got ${JSON.stringify(staleBody.error)} — the client keys its reload prompt off this`,
  );
  const noRevision = await postNote(galleyToken, { ...NOTE_BODY, revision: undefined });
  checkStatus('rounds: a note with no revision at all is refused', noRevision, 409);
}

/**
 * 6. THE ALLOWLIST. A valid signature is necessary but no longer sufficient: a
 * token grants nothing unless its row in preview_links is present and
 * un-revoked. This is the direction the positive paths cannot show — they prove
 * a good link still works, not that a withdrawn one stops.
 *
 * Revocation deliberately takes READING as well as writing, so each case asserts
 * both: a link that still opened the draft after being revoked would defeat the
 * point of revoking it. Reading notes goes through the same previewReviewer the
 * write does, so a third GET per case would add nothing.
 */
async function checkAllowlist(fixtureExp) {
  const cases = [
    ['revoked', LINKS.revoked.id],
    ['unrecorded', UNRECORDED_LINK_ID],
  ];
  for (const [label, linkId] of cases) {
    const token = await mint({
      slug: FIXTURE_SLUG, exp: fixtureExp, reviewer: SMOKE_REVIEWER, linkId,
    });
    const page = await fetch(withToken(`/blog/${FIXTURE_SLUG}/`, token));
    checkStatus(
      `galley: a ${label} link cannot open the post`,
      page, 404, 'a signature alone opened a draft the allowlist does not vouch for',
    );
    const write = await postNote(token, {
      slug: FIXTURE_SLUG, kind: 'comment', quote: 'test fixture', body: `${label} write`,
    });
    checkStatus(`galley: a ${label} link cannot leave a note`, write, 403);
  }
}

/**
 * 7. The write quota bounds a leaked review link between the moment it goes
 * astray and the moment anyone notices to revoke it. Revocation is the real
 * remedy; until someone knows the link leaked, this is what stops one from
 * filling the table.
 *
 * Fired in PARALLEL, deliberately. A sequential flood passes against a
 * check-then-insert quota, which is exactly the implementation that does not
 * hold. Someone with a leaked link has no reason to be polite about it, so the
 * test shouldn't be either.
 *
 * allSettled, not all: under Promise.all a single ECONNRESET rejects the whole
 * batch and takes every later assertion with it, turning a transport blip into
 * a total run failure that names nothing. But tolerating failures is only safe
 * with a floor underneath — allSettled alone would let a run where the worker
 * died mid-flood report zero accepted and sail through `accepted <= quota`,
 * which is vacuously true. FLOOD_MIN_USABLE converts that false green into a
 * red.
 *
 * Runs last in this section, since it fills the hour's allowance.
 */
async function checkWriteQuota(galleyToken) {
  const FLOOD_SIZE = 90;
  const FLOOD_MIN_USABLE = 81; // 90 % of the batch; tolerate a handful of blips
  const floodResults = await Promise.allSettled(
    Array.from({ length: FLOOD_SIZE }, (_, i) =>
      postNote(galleyToken, {
        slug: FIXTURE_SLUG, kind: 'comment', quote: 'test fixture', body: `flood ${i}`,
        // Must be the real revision, or every request is refused 409 before it
        // reaches the quota and both checks below go vacuous — which is exactly
        // what the floor check exists to turn into a visible failure.
        revision: FIXTURE_REVISION,
      }).then((res) => res.status)),
  );
  const flood = floodResults.filter((r) => r.status === 'fulfilled').map((r) => r.value);
  const dropped = floodResults.length - flood.length;
  const accepted = flood.filter((s) => s === 200).length;
  const refused = flood.filter((s) => s === 429).length;
  // Only 200 and 429 are answers to the question being asked. A 5xx means the
  // endpoint fell over rather than deciding, so it is counted as noise here and
  // reported by the floor check rather than being read as "not accepted".
  const usable = accepted + refused;
  const seen = [...new Set(flood)].sort().join(', ') || 'none';
  const tally = `${usable}/${FLOOD_SIZE} usable (${accepted} accepted, ${refused} refused` +
    `, ${flood.length - usable} other, ${dropped} dropped) — statuses seen: ${seen}`;

  check(
    'galley: the flood actually reached the endpoint',
    usable >= FLOOD_MIN_USABLE,
    `${tally}\n    too few requests came back to judge the quota by — the two ` +
      'checks below would be vacuously true, so this fails instead of them passing',
  );
  check(
    'galley: the write quota stops a flooded review link',
    refused > 0,
    `${FLOOD_SIZE} concurrent notes, none refused — ${tally}`,
  );
  // The bound has to hold under concurrency, not merely exist. Anything over
  // the cap means the count was observed and then invalidated before the row
  // landed — the race a sequential loop cannot see.
  check(
    'galley: the quota holds under concurrent writes',
    accepted <= GALLEY_WRITE_QUOTA,
    `${accepted} of ${FLOOD_SIZE} concurrent notes were accepted, quota is ` +
      `${GALLEY_WRITE_QUOTA} — check-then-insert raced past the limit (${tally})`,
  );
}

/**
 * 8. The anchoring contract, end to end. A data-src in served HTML must name the
 * line of the .mdx that actually holds that text. Unit tests cannot see this:
 * they build mdast by hand and so cannot catch remark's line numbers shifting
 * relative to the file (frontmatter being stripped, say), which would move every
 * anchor by a constant and silently misdirect every note.
 */
function checkAnchoring(galleyHtml) {
  const anchorMatch = /<p data-src="(\d+)-\d+"[^>]*>([^<]{25,80})/.exec(galleyHtml);
  check('galley: served HTML carries source anchors', anchorMatch !== null);
  if (!anchorMatch) return;

  const fixtureLines = readFileSync(
    resolve('src/content/blog', `${FIXTURE_SLUG}.mdx`),
    'utf8',
  ).split('\n');
  // Fold the typography smartypants introduces (’ for ', em dashes) before
  // comparing — see scripts/galley-pull.mjs, which folds the same way.
  const fold = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
  const sourceLine = fold(fixtureLines[Number(anchorMatch[1]) - 1] ?? '');
  const rendered = fold(anchorMatch[2]).slice(0, 25);
  check(
    'galley: an anchor points at the .mdx line holding its text',
    sourceLine.includes(rendered),
    `data-src said line ${anchorMatch[1]}, which reads ${JSON.stringify(sourceLine.slice(0, 60))} ` +
      `but the rendered text there starts ${JSON.stringify(rendered)}`,
  );
}

// ── the host-based unlock, both directions ─────────
//
// isPreviewHost is unit-tested as a pure function, and everything above runs on
// 127.0.0.1 (deliberately not a preview host). Neither proves the signal is
// actually WIRED UP: revert a call site to getPublishedPosts() with no argument
// and the whole suite stays green while PR previews silently stop showing
// drafts. Fail-closed, so not a leak — but a dead feature nobody would notice.
//
// NOTE: this cannot use fetch(). Node's fetch (undici) silently overwrites the
// Host header with the URL's origin, so `headers: { host }` is dropped and every
// assertion below would test 127.0.0.1 again — the negative ones would still
// pass, which is precisely how a broken version of this test looks healthy.
// node:http sends what it is given.
function asHost(path, hostname) {
  return new Promise((ok, fail) => {
    const req = httpRequest(
      { host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { Host: hostname } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        // Minimal fetch-Response shape so these read like the rest of the file.
        res.on('end', () =>
          ok({
            status: res.statusCode,
            headers: {
              get: (n) => {
                const v = res.headers[n.toLowerCase()];
                return Array.isArray(v) ? v.join(', ') : (v ?? null);
              },
            },
            text: async () => body,
          }),
        );
      },
    );
    req.on('error', fail);
    req.end();
  });
}

export async function checkHostUnlock() {
  const PREVIEW_HOST = `smoke-${WORKER_NAME}.example.workers.dev`;
  const [previewIndex, previewRss, previewPost] = await Promise.all([
    asHost('/blog', PREVIEW_HOST),
    asHost('/blog/rss.xml', PREVIEW_HOST),
    asHost(`/blog/${FIXTURE_SLUG}/`, PREVIEW_HOST),
  ]);
  check(
    'preview host: reveals the scheduled fixture on /blog',
    (await previewIndex.text()).includes(FIXTURE_SLUG),
    'a *.workers.dev preview host did not show the scheduled post — the showScheduled wiring may be broken',
  );
  checkHeader('preview host: /blog is no-store', previewIndex, 'cache-control', 'no-store');
  checkHeader('preview host: /blog is noindex', previewIndex, 'x-robots-tag', 'noindex');
  checkStatus('preview host: fixture URL 200s', previewPost, 200);
  check(
    'preview host: RSS includes the scheduled fixture',
    (await previewRss.text()).includes(FIXTURE_SLUG),
    'the host unlock is meant to widen RSS too (unlike a signed link)',
  );
  checkHeader('preview host: RSS is no-store', previewRss, 'cache-control', 'no-store');

  // The fixture belongs in the LISTINGS (that is what the three checks above
  // are for) but never in a slot that features ONE post: dated 2099, it is the
  // newest post there is wherever scheduled posts are visible, so a plain
  // newest-first pick made the home page's "From the Lexicon" block read
  // "Scheduled-post fixture (not a real post)" on every preview deploy.
  //
  // Only reachable here. In production the fixture is filtered by date long
  // before the teaser sees it, so the front page's own assertions in
  // live-site.mjs would stay green through this.
  const previewHome = await asHost('/', PREVIEW_HOST);
  const previewHomeHtml = await previewHome.text();
  // indexOf returns -1 when the marker is gone, and slice(-1) is the document's
  // LAST CHARACTER — which is non-empty and contains no slug, so the assertion
  // below passed on a home page that had lost the teaser entirely. Find the
  // offset first and assert on it, so a missing block fails loudly here rather
  // than reading as a passing check for something no longer on the page.
  const teaserAt = previewHomeHtml.indexOf('class="lexicon-teaser"');
  check(
    'preview host: the home page still renders a "From the Lexicon" block',
    teaserAt >= 0,
    'no .lexicon-teaser on / — the assertion below would be vacuous',
  );
  check(
    'preview host: "From the Lexicon" features a real post, not the fixture',
    teaserAt >= 0 && !previewHomeHtml.slice(teaserAt, teaserAt + 800).includes(FIXTURE_SLUG),
    'the home page featured the smoke fixture — getLatestPosts stopped skipping it',
  );

  // Same shape one surface over: previous/next is the other slot that names a
  // specific post, so the newest real post's "Next →" pointed at the fixture.
  //
  // The subject is discovered rather than named — the index is newest-first and
  // reveals the fixture on this host, so the first non-fixture post link is the
  // newest real post, which is precisely the one whose neighbour the fixture
  // would be. Naming a slug here would rot the day a post's date moved.
  const previewIndexHtml = await previewIndex.text();
  const newestRealSlug = [...previewIndexHtml.matchAll(/href="\/blog\/(?!tag\/|tags|rss)([^"/]+)\//g)]
    .map((m) => m[1])
    .find((slug) => slug !== FIXTURE_SLUG);
  check(
    'preview host: the index still lists a real post to check',
    !!newestRealSlug,
    'no non-fixture post link on /blog — the assertion below would be vacuous',
  );
  if (newestRealSlug) {
    const previewNewest = await asHost(`/blog/${newestRealSlug}/`, PREVIEW_HOST);
    const newestHtml = await previewNewest.text();
    const navStart = newestHtml.indexOf('class="post-nav"');
    const nav = navStart > 0 ? newestHtml.slice(navStart, newestHtml.indexOf('</nav>', navStart)) : '';
    check(
      `preview host: ${newestRealSlug} previous/next does not link the fixture`,
      nav.length > 0 && !nav.includes(FIXTURE_SLUG),
      navStart > 0
        ? 'the fixture is a neighbour again — getAdjacentPosts stopped filtering it'
        : 'no .post-nav on the newest post — previous/next is missing entirely',
    );
  }

  // The negative twin: the Worker's OWN workers.dev alias serves production on
  // a hostname anyone can derive from this repo, so it must NOT unlock. Only
  // proven at the unit level until now.
  const PROD_ALIAS_HOST = `${WORKER_NAME}.example.workers.dev`;
  const [aliasIndex, aliasRss] = await Promise.all([
    asHost('/blog', PROD_ALIAS_HOST),
    asHost('/blog/rss.xml', PROD_ALIAS_HOST),
  ]);
  check(
    'production workers.dev alias: does NOT reveal the fixture on /blog',
    !(await aliasIndex.text()).includes(FIXTURE_SLUG),
    'the production alias unlocked scheduled drafts — isPreviewHost regressed',
  );
  check(
    'production workers.dev alias: does NOT reveal the fixture in RSS',
    !(await aliasRss.text()).includes(FIXTURE_SLUG),
    'the production alias leaked a draft into the feed — this would trigger the subscriber email',
  );
  checkHeader(
    'production workers.dev alias: still cacheable',
    aliasIndex, 'cache-control', 'max-age=3600',
  );
}
