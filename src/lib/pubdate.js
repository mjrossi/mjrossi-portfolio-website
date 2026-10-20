// How a frontmatter date becomes an instant.
//
// `pubDate` decides when a post goes live, and since scheduled links are capped
// at publication (see src/lib/schedule.js) it also decides when a preview link
// stops working. Both make it worth being exact about what a given literal means.
//
// THE WHOLE PROBLEM IS QUOTING, and it is silent in both directions.
//
// Astro's frontmatter parser (the `yaml` package, with the YAML 1.1 timestamp
// tag) resolves an UNQUOTED timestamp to a Date itself — and YAML reads one with no offset as UTC:
//
//   pubDate: 2026-05-10               → Date, 2026-05-10T00:00:00Z
//   pubDate: 2026-05-10T14:00:00      → Date, 2026-05-10T14:00:00Z
//   pubDate: 2026-05-10T09:00:00-04:00 → Date, 2026-05-10T13:00:00Z
//
// QUOTE it and the parser hands back a string instead, which `new Date()` then
// parses by the ECMAScript rules — where a date-TIME with no offset is LOCAL:
//
//   pubDate: "2026-05-10"             → 2026-05-10T00:00:00Z   (same)
//   pubDate: "2026-05-10T14:00:00"    → 2026-05-10T18:00:00Z   (!) in America/New_York
//
// So the same literal means two different instants depending on a pair of quotes,
// with nothing red anywhere and a post that publishes up to a day off. That one
// case is rejected here, at build time, with a message saying how to fix it.
// Every other shape is unambiguous and passes through.
//
// Shared with scripts/content.mjs, so the code that decides when a post
// publishes is the code the minting scripts cap against. pubdate.test.js pins
// the parser behaviour every claim above rests on.

/** `2026-05-10` — a bare calendar day. UTC under both YAML and `new Date()`. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A time with an explicit offset. `T` only: this branch sees only QUOTED
 * strings, and `new Date()` on the space form is implementation-defined.
 */
const OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** `2026-05-10T14:00:00` — a time with NO offset. The one ambiguous shape. */
const NAIVE_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * A trailing zone. Anything zoned that reaches NAIVE_TIME_RE used a space for
 * the `T`, which needs a different message from a missing zone — the old one
 * suggested `"2026-05-10 14:00:00ZZ"`.
 */
const HAS_ZONE_RE = /(Z|[+-]\d{2}:?\d{2})$/;

/**
 * The literal to suggest, given one this file refuses. A suggestion that is
 * itself refused sends the author in a circle, so:
 *
 *   - add SECONDS: YAML 1.1 needs them, or `2026-05-10 14:00` stays a string;
 *   - use `T`, not a space: OFFSET_RE accepts only the `T` form.
 */
function canonical(text) {
  return text.replace(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?![:\d])/, '$1T$2:00').replace(' ', 'T');
}

/**
 * Turn a frontmatter value into an instant, or explain why not. Returns rather
 * than throws, so Zod and the scripts can each frame the message.
 *
 * @param {unknown} value
 * @param {string} [field] name used in the message, e.g. 'pubDate'
 * @returns {{ ok: true, date: Date } | { ok: false, message: string }}
 */
export function coercePubDate(value, field = 'pubDate') {
  // The normal path: unquoted in YAML, so the parser already resolved it.
  if (value instanceof Date) {
    return Number.isNaN(value.valueOf())
      ? { ok: false, message: `${field} is not a valid date` }
      : { ok: true, date: value };
  }

  if (typeof value !== 'string') {
    return {
      ok: false,
      message: `${field} must be a date, got ${value === null ? 'null' : typeof value}`,
    };
  }

  const text = value.trim();

  if (DATE_ONLY_RE.test(text) || OFFSET_RE.test(text)) {
    const date = new Date(text);
    return Number.isNaN(date.valueOf())
      ? { ok: false, message: `${field} ${JSON.stringify(value)} is not a valid date` }
      : { ok: true, date };
  }

  // The trap, refused rather than guessed: UTC contradicts `new Date()`, local
  // contradicts the unquoted literal. Two shapes, two different messages.
  if (NAIVE_TIME_RE.test(text)) {
    // Zone stated, but a space where the `T` belongs.
    const fixed = canonical(text);
    if (HAS_ZONE_RE.test(text)) {
      return {
        ok: false,
        message:
          `${field} ${JSON.stringify(value)} states its zone but separates the date and time ` +
          'with a space, and `new Date()` on that form is implementation-defined.\n' +
          '  Write the T — with the zone already stated, either form then works:\n' +
          `    ${field}: ${fixed}\n` +
          `    ${field}: ${JSON.stringify(fixed)}`,
      };
    }
    return {
      ok: false,
      message:
        `${field} ${JSON.stringify(value)} has a time but no time zone, and quoting it means ` +
        'local time — so it would publish at a different instant on a different machine.\n' +
        `  Remove the quotes (YAML reads a bare timestamp as UTC): ${field}: ${fixed}\n` +
        `  Or state the zone: ${field}: "${fixed}Z"  /  ${field}: "${fixed}-04:00"`,
    };
  }

  return {
    ok: false,
    message:
      `${field} ${JSON.stringify(value)} is not a date this site understands.\n` +
      '  Use YYYY-MM-DD, or a timestamp with a zone: 2026-05-10T14:00:00Z',
  };
}
