import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXTURE_SLUG, adjacentIn, latestIn, realPosts } from './archive.js';

// The archive as a sequence: which post a surface features, and which posts sit
// either side of one. See archive.js for why these take the list rather than
// fetching it.
//
// A post here is `{ id }` and nothing more — that is the whole of what these
// functions read, and stubbing it is what lets every case below be stated
// exactly rather than assembled out of whatever src/content/blog happens to
// hold this month. The live suite used to carry that job and could only ask it
// of the newest real post, so scheduling an ordinary post moved the answer.

const p = (id) => ({ id });
// Newest-first, the order getPublishedPosts returns.
const NEWEST_FIRST = [p('e'), p('d'), p('c'), p('b'), p('a')];
const fixture = p(FIXTURE_SLUG);

// ── the fixture is never a neighbour and never featured ────

test('the fixture is dropped from the sequence', () => {
  assert.deepEqual(
    realPosts([fixture, ...NEWEST_FIRST]).map((post) => post.id),
    ['e', 'd', 'c', 'b', 'a'],
  );
});

test('the newest real post has no next, even with the fixture above it', () => {
  // The bug this exists for: dated 2099, the fixture is the newest entry
  // wherever scheduled posts are visible, so the newest real post's "Next →"
  // pointed at "Scheduled-post fixture (not a real post)".
  const { previous, next } = adjacentIn([fixture, ...NEWEST_FIRST], 'e');
  assert.equal(next, null);
  assert.equal(previous.id, 'd');
});

test('the fixture is not featured, however many drafts sit under it', () => {
  assert.deepEqual(latestIn([fixture, ...NEWEST_FIRST], 2).map((post) => post.id), ['e', 'd']);
});

test('the fixture asked for its own neighbours gets none', () => {
  // It is excluded from the list it would be looking itself up in, so it lands
  // on the unknown-post branch. Its page renders no previous/next at all, which
  // is correct: it is a test artifact and its neighbours are not a thing anyone
  // needs.
  assert.deepEqual(adjacentIn([fixture, ...NEWEST_FIRST], FIXTURE_SLUG), {
    previous: null,
    next: null,
  });
});

// ── direction ─────────────────────────────────────────

test('previous is older and next is newer', () => {
  // Named for the reader's direction of travel through the archive, not for the
  // array's: the list is newest-first, so `previous` is the HIGHER index.
  const { previous, next } = adjacentIn(NEWEST_FIRST, 'c');
  assert.equal(previous.id, 'b');
  assert.equal(next.id, 'd');
});

// ── the ends ──────────────────────────────────────────

test('the oldest post has no previous', () => {
  const { previous, next } = adjacentIn(NEWEST_FIRST, 'a');
  assert.equal(previous, null);
  assert.equal(next.id, 'b');
});

test('the newest post has no next', () => {
  const { previous, next } = adjacentIn(NEWEST_FIRST, 'e');
  assert.equal(previous.id, 'd');
  assert.equal(next, null);
});

test('a single-post archive has neither, so the nav renders nothing', () => {
  assert.deepEqual(adjacentIn([p('only')], 'only'), { previous: null, next: null });
});

test('an empty archive is not an error', () => {
  assert.deepEqual(adjacentIn([], 'a'), { previous: null, next: null });
});

// ── a post the query cannot see ───────────────────────

test('a post absent from the list yields two nulls rather than throwing', () => {
  // A draft, on production. The route rendering it has already decided the
  // reader may be there — via a signed preview link, which is scoped to the
  // post's own URL and deliberately does not widen the listing helpers.
  assert.deepEqual(adjacentIn(NEWEST_FIRST, 'not-in-the-list'), {
    previous: null,
    next: null,
  });
});

// ── featuring ─────────────────────────────────────────

test('latestIn defaults to one post', () => {
  assert.deepEqual(latestIn(NEWEST_FIRST).map((post) => post.id), ['e']);
});

test('latestIn asking for more than the archive holds returns what there is', () => {
  assert.equal(latestIn([fixture, p('a')], 5).length, 1);
});

test('latestIn on a fixture-only archive features nothing', () => {
  // Not reachable in production, where the fixture is filtered by date long
  // before it gets here — but it is the shape the home page's teaser has to
  // survive on a preview host with no real drafts.
  assert.deepEqual(latestIn([fixture], 2), []);
});

// ── the inputs are not mutated ────────────────────────

test('the caller’s list is left alone', () => {
  // These rows come straight from the content collection and are the caller's,
  // the same reason resolveGroup returns a Map rather than writing onto its
  // input. Both functions filter, so this holds by construction — it is pinned
  // because a later "sort in place for safety" would not look like a bug.
  const input = [fixture, ...NEWEST_FIRST];
  const before = input.map((post) => post.id);
  adjacentIn(input, 'e');
  latestIn(input, 2);
  assert.deepEqual(input.map((post) => post.id), before);
});
