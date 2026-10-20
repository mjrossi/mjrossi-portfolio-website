// The masthead edition: "Vol. <volume> · No. <number> · <Month YYYY>".
//
// ONE derivation, from ONE launch epoch, called ONCE per render in Base.astro.
// When pages derived their own, the masthead's date went backwards as the
// reader clicked. Nothing in page chrome may compute an issue from content.
//
// The exception is scripts/make-post-og.mjs, which calls issue(pubDate): the
// issue a post RAN IN, fixed forever, rather than a "now" that a cached card
// would let go stale.
//
// Counts MONTHS SINCE LAUNCH, so twelve issues make a volume and the volume
// turns on the anniversary. An off-by-one here reads as an ordinary issue line,
// hence the tests.

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
 * The issue for an instant. `short` drops the month, for the post OG card,
 * which already shows the post's date. Dates before the epoch clamp to issue 1.
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

  // UTC, so the month doesn't depend on which edge answered.
  const monthYear = now.toLocaleString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return { volume, number, label: `${short} · ${monthYear}`, short };
}

/**
 * The full masthead line; what smoke matches on.
 *
 * @param {Date} [now]
 * @returns {string}
 */
export function editionLine(now = new Date()) {
  return issue(now).label;
}
