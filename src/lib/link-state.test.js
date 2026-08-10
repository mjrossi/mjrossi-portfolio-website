import test from 'node:test';
import assert from 'node:assert/strict';
import { linkState } from './link-state.js';

// The four words the roster and the Desk both answer "what is outstanding?"
// with. See link-state.js for why the case order is load-bearing.

const NOW = Date.UTC(2026, 4, 10, 12, 0, 0); // 2026-05-10T12:00:00Z
const NOW_SEC = Math.floor(NOW / 1000);

/** A live row with an hour to run and an hour of headroom above it. */
function row(over = {}) {
  return { exp: NOW_SEC + 3600, max_exp: NOW_SEC + 7200, revoked_at: null, ...over };
}

const FUTURE = new Date(NOW + 86_400_000); // publishes tomorrow
const PAST = new Date(NOW - 86_400_000); // published yesterday

// ── the four states ──────────────────────────────────

test('a running link on an unpublished post is live', () => {
  const s = linkState(row(), { pubDate: FUTURE, now: NOW });
  assert.equal(s.state, 'live');
  assert.equal(s.live, true);
  assert.deepEqual(s.expires, new Date((NOW_SEC + 3600) * 1000));
});

test('a row past its expiry is expired', () => {
  const s = linkState(row({ exp: NOW_SEC - 1 }), { pubDate: FUTURE, now: NOW });
  assert.equal(s.state, 'expired');
  assert.equal(s.live, false);
});

test('a withdrawn row is revoked, and carries the date', () => {
  const when = NOW - 1000;
  const s = linkState(row({ revoked_at: when }), { pubDate: FUTURE, now: NOW });
  assert.equal(s.state, 'revoked');
  assert.equal(s.live, false);
  assert.deepEqual(s.revokedAt, new Date(when));
});

test('a running link on a published post is spent, not live', () => {
  // The state that stopped the roster answering "what is outstanding?" with
  // "everything, forever".
  const s = linkState(row(), { pubDate: PAST, now: NOW });
  assert.equal(s.state, 'spent');
  assert.equal(s.live, false);
  assert.deepEqual(s.publishedAt, PAST);
});

// ── the order between them ───────────────────────────

test('revoked beats expired', () => {
  const s = linkState(row({ exp: NOW_SEC - 1, revoked_at: NOW - 1000 }), { now: NOW });
  assert.equal(s.state, 'revoked');
});

test('revoked beats spent', () => {
  const s = linkState(row({ revoked_at: NOW - 1000 }), { pubDate: PAST, now: NOW });
  assert.equal(s.state, 'revoked');
});

test('expired beats spent', () => {
  // Distinguishable only here, and the distinction matters: `expired` is the one
  // an operator can act on by extending.
  const s = linkState(row({ exp: NOW_SEC - 1 }), { pubDate: PAST, now: NOW });
  assert.equal(s.state, 'expired');
});

// ── boundaries ───────────────────────────────────────

test('expiry is inclusive: at exactly exp the link has expired', () => {
  // isLinkActive compares `exp * 1000 > now`, so at exactly exp it refuses the
  // request. These two must agree or the roster reports live links that 404.
  assert.equal(linkState(row({ exp: NOW_SEC }), { now: NOW }).state, 'expired');
  assert.equal(linkState(row({ exp: NOW_SEC + 1 }), { now: NOW }).state, 'live');
});

test('publication is inclusive: at exactly pubDate the post is public', () => {
  // isPublished compares `<=`, so the post is live at its own instant and the
  // link guarding it is spent at the same one — no gap, no overlap.
  assert.equal(linkState(row(), { pubDate: new Date(NOW), now: NOW }).state, 'spent');
  assert.equal(linkState(row(), { pubDate: new Date(NOW + 1), now: NOW }).state, 'live');
});

// ── extendTo ─────────────────────────────────────────

test('headroom is reported when extending would gain something', () => {
  const s = linkState(row(), { pubDate: FUTURE, now: NOW });
  assert.deepEqual(s.extendTo, new Date((NOW_SEC + 7200) * 1000));
});

test('headroom is clamped to publication, not the raw ceiling', () => {
  // 15 minutes left on the row, publication 30 minutes out, ceiling two hours.
  // There IS headroom, but only up to publication — reporting max_exp here would
  // advertise time preview-extend then clamps away.
  const soon = new Date(NOW + 1_800_000);
  const s = linkState(row({ exp: NOW_SEC + 900 }), { pubDate: soon, now: NOW });
  assert.deepEqual(s.extendTo, new Date(NOW + 1_800_000));
  // Without a pubDate the same row would reach the full ceiling, which is what
  // makes this a clamp rather than a coincidence.
  assert.deepEqual(linkState(row({ exp: NOW_SEC + 900 }), { now: NOW }).extendTo, new Date((NOW_SEC + 7200) * 1000));
});

test('a link already at its cap reports no headroom', () => {
  const at = row({ exp: NOW_SEC + 7200, max_exp: NOW_SEC + 7200 });
  assert.equal(linkState(at, { pubDate: FUTURE, now: NOW }).extendTo, null);
});

test('publication already inside the window leaves no headroom', () => {
  // The row runs an hour; the post goes live in half of that. There is nothing
  // to extend into, and the absence of a date is the answer.
  const soon = new Date(NOW + 1_800_000);
  const s = linkState(row({ exp: NOW_SEC + 3600, max_exp: NOW_SEC + 7200 }), {
    pubDate: soon,
    now: NOW,
  });
  assert.equal(s.extendTo, null);
});

test('revoked and spent links report no headroom', () => {
  // extendLink's UPDATE requires revoked_at IS NULL, and preview-extend refuses
  // a published post outright. Neither can move, so neither advertises a date.
  const opts = { pubDate: FUTURE, now: NOW };
  assert.equal(linkState(row({ revoked_at: NOW - 1 }), opts).extendTo, null);
  assert.equal(linkState(row(), { pubDate: PAST, now: NOW }).extendTo, null);
});

test('an EXPIRED link with a live ceiling still reports headroom', () => {
  // The recovery path: extendLink's WHERE never looks at the current exp, so a
  // lapsed link can be wound forward and comes back on the URL the reviewer
  // already has. Narrowing extendTo to live links looks like tidying and deletes
  // the reason extending beats reminting.
  const lapsed = row({ exp: NOW_SEC - 60, max_exp: NOW_SEC + 7200 });
  assert.equal(linkState(lapsed, { pubDate: FUTURE, now: NOW }).state, 'expired');
  assert.deepEqual(
    linkState(lapsed, { pubDate: FUTURE, now: NOW }).extendTo,
    new Date((NOW_SEC + 7200) * 1000),
  );
});

test('an expired link whose ceiling has ALSO passed reports none', () => {
  // Measured against exp alone this advertised a date in the past, because a
  // dead ceiling is still later than an older dead expiry. That link needs
  // reminting, and saying so by omission is the whole point of the suffix.
  const dead = row({ exp: NOW_SEC - 7200, max_exp: NOW_SEC - 60 });
  assert.equal(linkState(dead, { pubDate: FUTURE, now: NOW }).extendTo, null);
});

test('a missing max_exp reads as no headroom rather than unlimited', () => {
  const s = linkState({ exp: NOW_SEC + 3600, revoked_at: null }, { pubDate: FUTURE, now: NOW });
  assert.equal(s.state, 'live');
  assert.equal(s.extendTo, null);
});

// ── a post that is gone ──────────────────────────────

test('a null pubDate still classifies, because that link most needs revoking', () => {
  // A link minted against a post since renamed or deleted has to stay listable.
  const s = linkState(row(), { pubDate: null, now: NOW });
  assert.equal(s.state, 'live');
  assert.equal(s.publishedAt, null);
  assert.deepEqual(s.extendTo, new Date((NOW_SEC + 7200) * 1000));
});

test('a null pubDate never produces spent', () => {
  assert.equal(linkState(row(), { now: NOW }).state, 'live');
});

test('an undefined revoked_at is not treated as revoked', () => {
  // Columns come back from D1; a row shaped without the key must not read as a
  // withdrawal, which would hide a live link from the roster entirely.
  assert.equal(linkState({ exp: NOW_SEC + 3600, max_exp: NOW_SEC + 7200 }, { now: NOW }).state, 'live');
});
