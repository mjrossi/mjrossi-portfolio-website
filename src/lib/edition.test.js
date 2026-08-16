import test from 'node:test';
import assert from 'node:assert/strict';

import { EPOCH, issue, editionLine, toRoman } from './edition.js';

const at = (year, month) => new Date(Date.UTC(year, month - 1, 15, 12, 0, 0));

test('toRoman covers the range a masthead can reach', () => {
  assert.equal(toRoman(1), 'I');
  assert.equal(toRoman(4), 'IV');
  assert.equal(toRoman(9), 'IX');
  assert.equal(toRoman(12), 'XII');
  // The spec's lookup array stopped at XII and returned undefined past it,
  // which is a volume 13 years out — reachable, and silently blank.
  assert.equal(toRoman(13), 'XIII');
  assert.equal(toRoman(40), 'XL');
});

test('the launch month is issue one of volume one', () => {
  const first = issue(at(EPOCH.year, EPOCH.month));
  assert.deepEqual(
    { volume: first.volume, number: first.number },
    { volume: 1, number: 1 },
  );
  assert.equal(first.short, 'Vol. I · No. I');
});

test('the number counts months since launch, not the calendar month', () => {
  // August 2026 is the fifth issue of a periodical launched in April 2026 —
  // NOT No. VIII, which is what keying off the calendar month gave.
  assert.equal(issue(at(2026, 8)).label, 'Vol. I · No. V · August 2026');
});

test('a volume is twelve issues and turns over on the anniversary', () => {
  // The last issue of Vol. I, and the first of Vol. II, are adjacent months.
  const last = issue(at(2027, 3));
  const next = issue(at(2027, 4));
  assert.deepEqual({ v: last.volume, n: last.number }, { v: 1, n: 12 });
  assert.deepEqual({ v: next.volume, n: next.number }, { v: 2, n: 1 });
});

test('the number never leaves 1..12 and the volume only ever climbs', () => {
  let previous = 0;
  for (let m = 0; m < 120; m++) {
    const { volume, number } = issue(at(EPOCH.year + Math.floor(m / 12), (m % 12) + 1));
    assert.ok(number >= 1 && number <= 12, `month ${m} produced No. ${number}`);
    assert.ok(volume >= previous, `volume went backwards at month ${m}`);
    previous = volume;
  }
});

test('short is the label without the month, and both come from one call', () => {
  const i = issue(at(2026, 12));
  assert.equal(i.short, 'Vol. I · No. IX');
  assert.equal(i.label, 'Vol. I · No. IX · December 2026');
  assert.ok(i.label.startsWith(i.short));
});

test('editionLine is the label', () => {
  const now = at(2027, 1);
  assert.equal(editionLine(now), issue(now).label);
});

test('a date before the epoch clamps to the first issue', () => {
  const early = issue(at(2025, 1));
  assert.deepEqual({ v: early.volume, n: early.number }, { v: 1, n: 1 });
});

test('the month is read in UTC, not the host time zone', () => {
  // 23:30 on the 31st in UTC is the *next* month for anything east of it. The
  // worker runs in UTC and the line must not depend on which edge answered.
  const endOfMonth = new Date(Date.UTC(2026, 6, 31, 23, 30, 0));
  assert.equal(issue(endOfMonth).label, 'Vol. I · No. IV · July 2026');
});
