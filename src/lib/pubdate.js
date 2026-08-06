// How a frontmatter date becomes an instant.
//
// `pubDate` decides when a post goes live, and since scheduled links are capped
// at publication (see src/lib/schedule.js) it also decides when a preview link
// stops working. Both make it worth being exact about what a given literal means.
//
// THE WHOLE PROBLEM IS QUOTING, and it is silent in both directions.
//
// Astro parses frontmatter with js-yaml, which resolves an UNQUOTED timestamp to
// a Date itself — and YAML reads one with no offset as UTC:
//
//   pubDate: 2026-05-10               → Date, 2026-05-10T00:00:00Z
//   pubDate: 2026-05-10T14:00:00      → Date, 2026-05-10T14:00:00Z
//   pubDate: 2026-05-10T09:00:00-04:00 → Date, 2026-05-10T13:00:00Z
//
// QUOTE it and js-yaml hands back a string instead, which `new Date()` then
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
// Plain JS for the same reason as schedule.js and csp.js: `node --test` imports
// it directly, and scripts/content.mjs imports it too — so the code that decides
// when a post publishes is literally the code the minting scripts cap against.
// See src/lib/pubdate.test.js, which also pins js-yaml's own behaviour, since
// every claim above rests on it.

/** `2026-05-10` — a bare calendar day. UTC under both YAML and `new Date()`. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `2026-05-10T14:00:00Z`, `…+05:30`, `…-04:00` — a time with an explicit offset.
 *
 * `T` only, never a space. YAML permits `2026-05-10 14:00:00Z`, but this branch
 * only ever sees strings the author QUOTED, and `new Date()` on a space-separated
 * form is implementation-defined. Rejecting it sends the author to the same fix
 * as every other quoted-with-time case: unquote it.
 */
const OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/** `2026-05-10T14:00:00` — a time with NO offset. The one ambiguous shape. */
const NAIVE_TIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;

/**
 * Turn a frontmatter value into an instant, or explain why it can't be one.
 *
 * Returns a result rather than throwing so both callers can frame the failure in
 * their own terms — Zod attaches it to the offending field, and a script prefixes
 * it with its own name.
 *
 * @param {unknown} value
 * @param {string} [field] name used in the message, e.g. 'pubDate'
 * @returns {{ ok: true, date: Date } | { ok: false, message: string }}
 */
export function coercePubDate(value, field = 'pubDate') {
  // The normal path: unquoted in YAML, so js-yaml already resolved it.
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

  // The trap. Refused rather than guessed at, because either guess is wrong for
  // somebody: reading it as UTC contradicts `new Date()`, and reading it as local
  // contradicts the unquoted form of the same literal.
  if (NAIVE_TIME_RE.test(text)) {
    return {
      ok: false,
      message:
        `${field} ${JSON.stringify(value)} has a time but no time zone, and quoting it means ` +
        'local time — so it would publish at a different instant on a different machine.\n' +
        `  Remove the quotes (YAML reads a bare timestamp as UTC): ${field}: ${text}\n` +
        `  Or state the zone: ${field}: "${text}Z"  /  ${field}: "${text}-04:00"`,
    };
  }

  return {
    ok: false,
    message:
      `${field} ${JSON.stringify(value)} is not a date this site understands.\n` +
      '  Use YYYY-MM-DD, or a timestamp with a zone: 2026-05-10T14:00:00Z',
  };
}
