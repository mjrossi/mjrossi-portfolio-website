// Unit tests for frontmatter date coercion. Run via `npm test`.
//
// Two groups, and the first is the more important one.
//
// PINNING js-yaml. Everything coercePubDate does rests on a claim about a
// library nobody in this repo calls directly: that an unquoted YAML timestamp
// arrives as a Date, already in UTC when it carries no offset. If that ever
// changed — a js-yaml major, or Astro swapping parsers — posts would publish at
// the wrong hour and every one of these dates would still look right in the
// file. These tests are what turns that into a red suite instead. js-yaml is a
// direct dependency for this reason as much as for scripts/content.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { coercePubDate } from './pubdate.js';

/** Parse one frontmatter line the way Astro's loader would. */
const front = (line) => yaml.load(line);

// ── what js-yaml actually does ───────────────────────

test('an unquoted YYYY-MM-DD resolves to a Date at midnight UTC', () => {
  const { pubDate } = front('pubDate: 2026-05-10');
  assert.ok(pubDate instanceof Date);
  assert.equal(pubDate.toISOString(), '2026-05-10T00:00:00.000Z');
});

test('an unquoted timestamp with no offset resolves as UTC', () => {
  // The load-bearing one. If this ever parsed as local, every timed post would
  // publish hours early or late depending on where the build ran.
  const { pubDate } = front('pubDate: 2026-05-10T14:00:00');
  assert.ok(pubDate instanceof Date);
  assert.equal(pubDate.toISOString(), '2026-05-10T14:00:00.000Z');
});

test('an unquoted timestamp with an offset is honoured', () => {
  const { pubDate } = front('pubDate: 2026-05-10T09:00:00-04:00');
  assert.equal(pubDate.toISOString(), '2026-05-10T13:00:00.000Z');
});

test('a QUOTED timestamp stays a string — this is the trap', () => {
  // js-yaml hands back a string, `new Date()` reads a naive time as LOCAL, and
  // the same literal therefore means two different instants depending on a pair
  // of quotes. coercePubDate refuses this shape; the tests below prove it.
  const { pubDate } = front('pubDate: "2026-05-10T14:00:00"');
  assert.equal(typeof pubDate, 'string');
});

// ── coercePubDate ────────────────────────────────────

test('a Date passes straight through', () => {
  const date = new Date('2026-05-10T14:00:00Z');
  const result = coercePubDate(date);
  assert.equal(result.ok, true);
  assert.equal(result.date, date);
});

test('an invalid Date is rejected rather than passed on', () => {
  assert.equal(coercePubDate(new Date('nonsense')).ok, false);
});

test('a quoted date-only string is UTC, and accepted', () => {
  const result = coercePubDate('2026-05-10');
  assert.equal(result.ok, true);
  assert.equal(result.date.toISOString(), '2026-05-10T00:00:00.000Z');
});

test('a quoted timestamp with an explicit zone is accepted', () => {
  for (const [text, iso] of [
    ['2026-05-10T14:00:00Z', '2026-05-10T14:00:00.000Z'],
    ['2026-05-10T09:00:00-04:00', '2026-05-10T13:00:00.000Z'],
    ['2026-05-10T14:00Z', '2026-05-10T14:00:00.000Z'],
    ['2026-05-10T14:00:00.500Z', '2026-05-10T14:00:00.500Z'],
  ]) {
    const result = coercePubDate(text);
    assert.equal(result.ok, true, `${text} should be accepted`);
    assert.equal(result.date.toISOString(), iso);
  }
});

test('a quoted timestamp with NO zone is rejected, and the message says how to fix it', () => {
  const result = coercePubDate('2026-05-10T14:00:00');
  assert.equal(result.ok, false);
  // The fix has to be in the message: the author is looking at a line that reads
  // entirely correctly, and the only thing wrong with it is the quotes.
  assert.match(result.message, /Remove the quotes/);
  assert.match(result.message, /2026-05-10T14:00:00Z/);
});

test('a space-separated quoted timestamp is rejected too', () => {
  // Legal YAML, but `new Date()` on it is implementation-defined, and the fix is
  // the same one: unquote it.
  const result = coercePubDate('2026-05-10 14:00:00Z');
  assert.equal(result.ok, false);
  // Refused for the SPACE, not for a missing zone — it states one. Naming the
  // wrong punctuation sends the author looking for something they did not omit.
  assert.doesNotMatch(result.message, /no time zone/);
  assert.match(result.message, /space/);
});

// ── the messages have to be followable ───────────────
//
// Every literal a message suggests must actually be accepted. This is the
// property that broke: the "or state the zone" line appended a zone to a string
// that already carried one and confidently offered `"2026-05-10 14:00:00ZZ"`,
// which is not a date in any notation. Matching the prose would not have caught
// that — only running the suggestions back through the same two steps the build
// takes does, which is what this does.

/** Pull every `pubDate: <literal>` a message offers, quoted or bare. */
function suggestionsIn(message) {
  return message
    .split('pubDate: ')
    .slice(1)
    .map((segment) => {
      const quoted = /^"([^"]*)"/.exec(segment);
      // Bare literals may contain a single space (`2026-05-10 14:00:00Z`), so the
      // run ends at a newline or the two-space gutter between two suggestions.
      return quoted
        ? { quoted: true, text: quoted[1] }
        : { quoted: false, text: segment.split(/\n|\s{2,}/)[0].trim() };
    });
}

// Minute precision and the space form are in here deliberately: YAML 1.1 needs
// SECONDS, so `2026-05-10 14:00` unquoted comes back a string and lands right
// back on this error, and OFFSET_RE takes only the `T` form, so `"… 14:00Z"`
// would be refused as well. Both were suggested before `canonical` existed.
for (const input of [
  '2026-05-10T14:00:00',
  '2026-05-10 14:00:00Z',
  '2026-05-10 14:00',
  '2026-05-10T14:00',
  '2026-05-10 14:00Z',
  '2026-05-10 14:00:00',
]) {
  test(`every fix suggested for ${JSON.stringify(input)} is itself accepted`, () => {
    const result = coercePubDate(input);
    assert.equal(result.ok, false);

    const suggestions = suggestionsIn(result.message);
    assert.ok(suggestions.length >= 2, `expected fixes, got ${JSON.stringify(result.message)}`);

    for (const { quoted, text } of suggestions) {
      // A QUOTED suggestion stays a string, so coercePubDate sees it directly.
      // An UNQUOTED one is a YAML timestamp first — the same two steps in the
      // same order as Astro's loader, which is the whole point of the advice.
      const value = quoted ? text : front(`pubDate: ${text}`).pubDate;
      assert.equal(
        coercePubDate(value).ok,
        true,
        `suggested ${quoted ? JSON.stringify(text) : text}, which is not accepted`,
      );
    }
  });
}

test('the field name appears in the message', () => {
  const result = coercePubDate('nonsense', 'updatedDate');
  assert.equal(result.ok, false);
  assert.match(result.message, /updatedDate/);
});

test('non-dates are rejected by type', () => {
  for (const value of [null, undefined, 20260510, {}, []]) {
    assert.equal(coercePubDate(value).ok, false, `${JSON.stringify(value)} should be rejected`);
  }
});
