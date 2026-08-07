// Unit tests for the scheduled-publishing predicate. Run via `npm test`.
//
// These exist because the smoke test cannot cover this: smoke asserts the
// built RSS feed contains no future-dated items, which is vacuously true
// whenever every committed post is already published. Deleting the filter
// entirely would keep smoke green. These tests fail instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clampToPublication, isPublished, publicationTime } from './schedule.js';

const NOW = Date.parse('2026-07-20T12:00:00Z');

test('a past pubDate is published', () => {
  assert.equal(isPublished(new Date('2026-05-01'), NOW), true);
});

test('a future pubDate is not published', () => {
  assert.equal(isPublished(new Date('2099-01-01'), NOW), false);
});

test('a pubDate one day out is not published', () => {
  assert.equal(isPublished(new Date('2026-07-21'), NOW), false);
});

test('the boundary is inclusive — visible exactly at midnight UTC', () => {
  const midnight = Date.parse('2026-07-20T00:00:00Z');
  assert.equal(isPublished(new Date(midnight), midnight), true);
});

test('one millisecond before midnight UTC is still hidden', () => {
  const midnight = Date.parse('2026-07-20T00:00:00Z');
  assert.equal(isPublished(new Date(midnight), midnight - 1), false);
});

test('a bare YYYY-MM-DD frontmatter date parses as midnight UTC', () => {
  // Guards the assumption the boundary semantics rest on: if this ever
  // parsed as local midnight, scheduling would fire hours early or late.
  assert.equal(new Date('2026-07-20').valueOf(), Date.parse('2026-07-20T00:00:00Z'));
});

test('now defaults to the current time when omitted', () => {
  assert.equal(isPublished(new Date('2000-01-01')), true);
  assert.equal(isPublished(new Date('2099-01-01')), false);
});

// ── a pubDate carrying a time of day ─────────────────
//
// Midnight UTC is only the default. A post can name an hour, and once preview
// links are capped at publication the exact instant is what a link expires on —
// so the boundary is worth pinning at both resolutions.

test('the boundary holds at an hour, not just a day', () => {
  const noon = Date.parse('2026-07-20T14:00:00Z');
  assert.equal(isPublished(new Date(noon), noon), true);
  assert.equal(isPublished(new Date(noon), noon - 1), false);
});

test('a timed post is still hidden earlier the same day', () => {
  const pubDate = new Date('2026-07-20T14:00:00Z');
  assert.equal(isPublished(pubDate, Date.parse('2026-07-20T09:00:00Z')), false);
  assert.equal(isPublished(pubDate, Date.parse('2026-07-20T15:00:00Z')), true);
});

// ── publication as a bound on a preview link ─────────

test('publicationTime is the pubDate in epoch seconds', () => {
  assert.equal(publicationTime(new Date('2026-07-20T14:00:00Z')), 1784556000);
});

test('publicationTime rounds UP, so a link never expires before the post appears', () => {
  // Sub-second precision is unusual in frontmatter but free to be right about:
  // rounding down would leave a window where the link is dead and the post is
  // not yet live.
  const pubDate = new Date('2026-07-20T14:00:00.500Z');
  assert.equal(publicationTime(pubDate) * 1000 >= pubDate.valueOf(), true);
});

test('the link expires exactly as the post appears — no gap, no overlap', () => {
  // The two comparisons meet here: isLinkActive is exclusive (`exp * 1000 > now`)
  // and isPublished is inclusive (`pubDate <= now`), so at this instant the grant
  // is already dead and the post is already public.
  const pubDate = new Date('2026-07-20T14:00:00Z');
  const at = pubDate.valueOf();
  const exp = clampToPublication(Math.floor(at / 1000) + 99999, pubDate);
  assert.equal(exp * 1000 > at, false, 'link must be expired at publication');
  assert.equal(isPublished(pubDate, at), true, 'post must be live at publication');
  assert.equal(exp * 1000 > at - 1, true, 'link must still be live a millisecond earlier');
});

test('clampToPublication leaves a window that ends before publication alone', () => {
  const pubDate = new Date('2026-07-20T14:00:00Z');
  const earlier = publicationTime(pubDate) - 3600;
  assert.equal(clampToPublication(earlier, pubDate), earlier);
});

test('clampToPublication cuts a window that would outlive publication', () => {
  const pubDate = new Date('2026-07-20T14:00:00Z');
  const later = publicationTime(pubDate) + 3600;
  assert.equal(clampToPublication(later, pubDate), publicationTime(pubDate));
});

test('clampToPublication returns a past expiry for an already-published post', () => {
  // Documented, not accidental: the clamp is pure, and the caller is the one that
  // knows whether minting for a live post is legitimate. preview-link checks
  // isPublished first so the local galley trial loop still works on any post.
  const pubDate = new Date('2020-01-01T00:00:00Z');
  assert.equal(clampToPublication(Math.floor(Date.now() / 1000) + 3600, pubDate) * 1000 < Date.now(), true);
});
