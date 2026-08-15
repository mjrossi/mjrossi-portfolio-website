// The masthead edition: "Vol. <volume> · No. <number> · <Month YYYY>".
//
// ONE derivation, from ONE fixed launch epoch, called ONCE per render in
// Base.astro. That is the whole point of this module. The August 2026 design
// review found home, /projects and a post reading `No. VIII · August 2026`
// while /blog read `No. VII · July 2026` — a masthead whose date went backwards
// as the reader clicked, on the one element whose entire job is to look
// authoritative. Nothing may compute an issue from a page, a route, or a
// content date; if a surface needs the issue, it takes it from here.
//
// The number counts MONTHS SINCE LAUNCH, not the calendar month. The old rule
// (`No.` = calendar month, volume = calendar years since 2024) had the two
// halves answering to different clocks: No. XII was December whether the
// periodical was one month old or nine, and the volume turned over on New
// Year's Day regardless. Counting from the epoch ties them together — twelve
// issues to a volume, the volume turning on the anniversary — which is what a
// masthead of this conceit actually claims.
//
// Plain JS rather than TypeScript so `node --test` can import it directly (same
// reason as schedule.js and pubdate.js). The failure mode here is a plausible
// wrong number — an off-by-one in the modulo reads as a perfectly ordinary
// issue line — so it needs tests, and tests need an importable module.

/** Launch month: the repo's first commits and the Broadsheet redesign. */
export const EPOCH = { year: 2026, month: 4 };

const ROMAN_MAP = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'],
  [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'],
  [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I'],
];

/**
 * @param {number} n
 * @returns {string}
 */
export function toRoman(n) {
  let out = '';
  let rem = n;
  for (const [v, s] of ROMAN_MAP) {
    while (rem >= v) { out += s; rem -= v; }
  }
  return out;
}

/**
 * The issue for an instant.
 *
 * `short` is the compact masthead's half of this — the interior pages carry
 * `Vol. I · No. V` without the month, because the month is already in every
 * dateline below it. Both come from the same call so the two mastheads cannot
 * drift the way the pages did.
 *
 * Dates before the epoch clamp to issue 1 rather than running negative. That is
 * unreachable in production (the site cannot be served before it launched) but
 * it is reachable from a test, a mistyped EPOCH, or a machine with a wrong
 * clock, and `Vol. 0 · No. -3` is a worse answer than the first issue.
 *
 * @param {Date} [now]
 * @returns {{ volume: number, number: number, label: string, short: string }}
 */
export function issue(now = new Date()) {
  const elapsed = (now.getUTCFullYear() - EPOCH.year) * 12
    + (now.getUTCMonth() + 1 - EPOCH.month);
  const months = Math.max(0, elapsed);

  const volume = Math.floor(months / 12) + 1;
  const number = (months % 12) + 1;
  const short = `Vol. ${toRoman(volume)} · No. ${toRoman(number)}`;

  // UTC throughout: the worker runs in UTC and the month must not depend on
  // which edge answered the request.
  const monthYear = now.toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return { volume, number, label: `${short} · ${monthYear}`, short };
}

/**
 * The full masthead line. Kept as a named export because it is what the full
 * masthead renders and what smoke matches on.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function editionLine(now = new Date()) {
  return issue(now).label;
}
