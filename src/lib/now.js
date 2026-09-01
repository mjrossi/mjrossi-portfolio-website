// The "Now" section's dateline.
//
// Finding 3.3: a Now block the reader can date is worse than no Now block, and
// the copy had gone three months stale in the future tense. The date is a
// single config value rather than a string inside the markup so that updating
// the section means updating one obvious line — and so a malformed value fails
// the build instead of rendering "Updated undefined".
//
// Plain JS with a test, for the usual reason: the failure here is a plausible
// wrong month, which reads as perfectly ordinary.

/** Month the Now section was last rewritten. `YYYY-MM`. */
export const NOW_UPDATED = '2026-09';

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * `'2026-08'` → `'Updated August 2026'`.
 *
 * Formatted from the parts rather than through `new Date('2026-08')`, which
 * parses as midnight UTC and then renders as the *previous* month for anyone
 * west of Greenwich — the one bug this line cannot afford, since its whole job
 * is to state a date accurately.
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
