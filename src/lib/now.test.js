import test from 'node:test';
import assert from 'node:assert/strict';

import { NOW_UPDATED, nowUpdatedLabel } from './now.js';

test('formats a YYYY-MM into the dateline', () => {
  assert.equal(nowUpdatedLabel('2026-08'), 'Updated August 2026');
  assert.equal(nowUpdatedLabel('2026-01'), 'Updated January 2026');
  assert.equal(nowUpdatedLabel('2027-12'), 'Updated December 2027');
});

test('the committed value is well formed', () => {
  assert.doesNotThrow(() => nowUpdatedLabel(NOW_UPDATED));
});

test('a malformed value fails loudly rather than rendering nonsense', () => {
  for (const bad of ['2026-8', 'August 2026', '2026-13', '2026-00', '2026', '', null]) {
    assert.throws(() => nowUpdatedLabel(bad), /NOW_UPDATED/, `accepted ${JSON.stringify(bad)}`);
  }
});

test('the month does not shift with the host time zone', () => {
  // `new Date('2026-08')` is midnight UTC, which is July 31st in New York.
  // Formatting from the parts is what keeps this from being "Updated July".
  const original = process.env.TZ;
  try {
    process.env.TZ = 'America/New_York';
    assert.equal(nowUpdatedLabel('2026-08'), 'Updated August 2026');
  } finally {
    if (original === undefined) delete process.env.TZ;
    else process.env.TZ = original;
  }
});
