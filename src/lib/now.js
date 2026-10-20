// The home page's "Now" dateline. One config value, so updating the section is
// one obvious line and a malformed value fails the build.

/** Month the Now section was last rewritten. `YYYY-MM`. */
export const NOW_UPDATED = '2026-10';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * `'2026-08'` → `'Updated August 2026'`. Formatted from the parts: `new
 * Date('2026-08')` is midnight UTC, which renders as July west of Greenwich.
 *
 * @param {string} [value]
 * @returns {string}
 */
export function nowUpdatedLabel(value = NOW_UPDATED) {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const month = match ? Number(match[2]) : 0;
  if (!match || month < 1 || month > 12) {
    throw new Error(`NOW_UPDATED must be YYYY-MM with a real month, got ${JSON.stringify(value)}`);
  }
  return `Updated ${MONTHS[month - 1]} ${match[1]}`;
}
