import test from 'node:test';
import assert from 'node:assert/strict';
import { countdown, deskIndex } from './desk.js';

// What earns a row on the Desk index, and in what order. See desk.js for why
// the row set is a union rather than a filter over the collection.

const NOW = Date.UTC(2026, 4, 10, 12, 0, 0);
const NOW_SEC = Math.floor(NOW / 1000);
const day = (n) => new Date(NOW + n * 86_400_000);

const post = (slug, days, title = slug) => ({ slug, title, pubDate: day(days) });
const link = (slug, over = {}) => ({
  id: 'a'.repeat(16),
  slug,
  reviewer: null,
  exp: NOW_SEC + 3600,
  max_exp: NOW_SEC + 7200,
  revoked_at: null,
  ...over,
});

const index = (input) => deskIndex({ now: NOW, ...input });

// ── what earns a row ─────────────────────────────────

test('a scheduled post is always listed, even with nothing outstanding', () => {
  const out = index({ posts: [post('draft', 3)] });
  assert.equal(out.posts.length, 1);
  assert.equal(out.posts[0].published, false);
});

test('a published post with nothing outstanding is omitted', () => {
  // The steady state of every post the blog has ever run. Listing them would
  // bury the rows that need something.
  const out = index({ posts: [post('old', -30)] });
  assert.deepEqual(out.posts, []);
});

test('a published post with an open note is listed', () => {
  // A round can outlive its draft: publish while notes are open and the
  // feedback is still yours to deal with.
  const out = index({ posts: [post('old', -30)], openNotes: new Map([['old', 2]]) });
  assert.equal(out.posts.length, 1);
  assert.equal(out.posts[0].openNotes, 2);
});

test('a published post with a live link is listed', () => {
  // Its links read `spent` rather than `live`, so this needs a link that is
  // genuinely outstanding — which for a published post it cannot be. The row
  // therefore comes from the note case above; here we prove the spent link
  // alone does NOT resurrect the row.
  const out = index({ posts: [post('old', -30)], links: [link('old')] });
  assert.deepEqual(out.posts, [], 'a spent link is not something to deal with');
});

test('a live link on a scheduled post counts, a revoked or expired one does not', () => {
  const out = index({
    posts: [post('draft', 3)],
    links: [
      link('draft', { id: '1'.repeat(16) }),
      link('draft', { id: '2'.repeat(16), revoked_at: NOW - 1 }),
      link('draft', { id: '3'.repeat(16), exp: NOW_SEC - 1 }),
    ],
  });
  assert.equal(out.posts[0].liveLinks, 1);
  assert.equal(out.posts[0].totalLinks, 3, 'the roster still shows all three');
});

// ── order ────────────────────────────────────────────

test('scheduled posts come before published ones', () => {
  const out = index({
    posts: [post('old', -30), post('draft', 3)],
    openNotes: new Map([['old', 5]]),
  });
  assert.deepEqual(
    out.posts.map((row) => row.slug),
    ['draft', 'old'],
  );
});

test('among scheduled posts the soonest publication comes first', () => {
  // Publication is the deadline everything else hangs off.
  const out = index({ posts: [post('later', 20), post('soon', 1), post('mid', 7)] });
  assert.deepEqual(
    out.posts.map((row) => row.slug),
    ['soon', 'mid', 'later'],
  );
});

test('among published posts the most open notes come first, then slug', () => {
  const out = index({
    posts: [post('a', -10), post('b', -10), post('c', -10)],
    openNotes: new Map([
      ['a', 1],
      ['b', 9],
      ['c', 1],
    ]),
  });
  assert.deepEqual(
    out.posts.map((row) => row.slug),
    ['b', 'a', 'c'],
  );
});

// ── orphan links ─────────────────────────────────────

test('links for a slug with no post are reported separately', () => {
  // The link most in need of revoking and the hardest to find — the reason
  // preview-roster grew --all.
  const out = index({ posts: [post('draft', 3)], links: [link('vanished')] });
  assert.equal(out.posts.length, 1);
  assert.deepEqual(
    out.orphans.map((group) => group.slug),
    ['vanished'],
  );
  assert.equal(out.orphans[0].links.length, 1);
});

test('orphan groups are sorted and carry every link for the slug', () => {
  const out = index({
    posts: [],
    links: [link('zeta'), link('alpha', { id: '1'.repeat(16) }), link('alpha', { id: '2'.repeat(16) })],
  });
  assert.deepEqual(
    out.orphans.map((group) => group.slug),
    ['alpha', 'zeta'],
  );
  assert.equal(out.orphans[0].links.length, 2);
});

test('a post that exists is never an orphan', () => {
  const out = index({ posts: [post('draft', 3)], links: [link('draft')] });
  assert.deepEqual(out.orphans, []);
});

// ── totals ───────────────────────────────────────────

test('totals count what the page actually shows', () => {
  const out = index({
    posts: [post('draft', 3), post('old', -30)],
    links: [link('draft'), link('draft', { id: '9'.repeat(16) })],
    openNotes: new Map([['old', 4]]),
  });
  assert.deepEqual(out.totals, { scheduled: 1, liveLinks: 2, openNotes: 4 });
});

test('an orphan link is not folded into the live-link total', () => {
  // It has no pubDate to classify against, and a total nothing on the page adds
  // up to is worse than one the orphan section reports on its own terms.
  const out = index({ posts: [post('draft', 3)], links: [link('vanished')] });
  assert.equal(out.totals.liveLinks, 0);
});

test('notes for a slug with no post do not invent a row', () => {
  const out = index({ posts: [], openNotes: new Map([['gone', 3]]) });
  assert.deepEqual(out.posts, []);
  assert.equal(out.totals.openNotes, 0);
});

// ── boundaries and empty input ───────────────────────

test('a post publishing exactly now counts as published', () => {
  const out = index({ posts: [post('now', 0)] });
  assert.deepEqual(out.posts, []);
});

test('no posts, no links and no notes is an empty desk', () => {
  const out = index({ posts: [] });
  assert.deepEqual(out.posts, []);
  assert.deepEqual(out.orphans, []);
  assert.deepEqual(out.totals, { scheduled: 0, liveLinks: 0, openNotes: 0 });
});

// ── the countdown ────────────────────────────────────
//
// NOW is midday UTC, so every case below sits inside the same day and the two
// that matter are the ones on either side of midnight. Counting elapsed time
// instead of calendar days got both wrong — thirty minutes out read "tomorrow",
// twenty-five hours out read "in 2 days" — while every case a day or more away
// stayed right, which is why it survived.

const hours = (n) => new Date(NOW + n * 3_600_000);

test('publishing later today is today, not tomorrow', () => {
  assert.equal(countdown(hours(0.5), NOW), 'publishes today');
  assert.equal(countdown(hours(11), NOW), 'publishes today');
});

test('publishing after midnight UTC is tomorrow, however few hours away', () => {
  // 12.5h from midday is 00:30 the next day: a different date, so "tomorrow",
  // even though less than a day has elapsed.
  assert.equal(countdown(hours(12.5), NOW), 'publishes tomorrow');
  assert.equal(countdown(hours(25), NOW), 'publishes tomorrow');
});

test('further out counts calendar days, not elapsed 24h blocks', () => {
  // From midday, 36h and 49h both land on the day after tomorrow — 49 hours is
  // "2 days" here and "3 days" under the old ceiling, which is the same mistake
  // one step further out.
  assert.equal(countdown(hours(36), NOW), 'publishes in 2 days');
  assert.equal(countdown(hours(49), NOW), 'publishes in 2 days');
  assert.equal(countdown(hours(61), NOW), 'publishes in 3 days');
});

test('the countdown names the same day as the date beside it', () => {
  // The invariant the calendar-day count exists for: the row prints pubDate
  // formatted in UTC next to this string, and they must not disagree.
  for (const h of [0.5, 5, 11.9, 12.1, 25, 36, 100]) {
    const pubDate = hours(h);
    const daysApart =
      (Date.UTC(pubDate.getUTCFullYear(), pubDate.getUTCMonth(), pubDate.getUTCDate()) -
        Date.UTC(2026, 4, 10)) /
      86_400_000;
    const expected =
      daysApart === 0
        ? 'publishes today'
        : daysApart === 1
          ? 'publishes tomorrow'
          : `publishes in ${daysApart} days`;
    assert.equal(countdown(pubDate, NOW), expected, `${h}h out`);
  }
});
