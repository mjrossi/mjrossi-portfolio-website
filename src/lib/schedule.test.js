// Unit tests for the scheduled-publishing predicate. Run via `npm test`.
//
// These exist because the smoke test cannot cover this: smoke asserts the
// built RSS feed contains no future-dated items, which is vacuously true
// whenever every committed post is already published. Deleting the filter
// entirely would keep smoke green. These tests fail instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPublished } from './schedule.js';

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
