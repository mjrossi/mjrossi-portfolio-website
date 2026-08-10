// What a preview_links row means right now: live, expired, revoked, or spent.
//
// Extracted from scripts/preview-roster.mjs's format(), which is where this
// vocabulary was invented and where it was the roster's private business until
// the Desk at /admin came to need the same four words. Two derivations of "live"
// is how a roster and a dashboard start disagreeing about what is outstanding —
// and "what is outstanding?" is the only question either of them exists to
// answer.
//
// Presentation stays with each caller. The CLI wants one padded line and the
// Desk wants markup; what they must share is the CLASSIFICATION, so this returns
// a decided state and the dates behind it rather than a formatted string.
//
// Plain JS, like schedule.js: `node --test` reaches it, the worker imports it,
// and scripts/ imports it without TypeScript tooling.

import { clampToPublication, isPublished } from './schedule.js';

/**
 * @typedef {object} LinkState
 * @property {'live'|'expired'|'revoked'|'spent'} state
 * @property {boolean} live whether this link is outstanding in any sense that
 *   matters — exactly `state === 'live'`, named because it is what the roster's
 *   "N still live" tally and the Desk's per-post count both mean.
 * @property {Date} expires the row's own effective expiry.
 * @property {Date|null} revokedAt when it was withdrawn, for `state === 'revoked'`.
 * @property {Date|null} publishedAt when the post went live, for `state === 'spent'`.
 * @property {Date|null} extendTo how far `just preview-extend` could move this
 *   link, or null when extending is not available or would gain nothing.
 */

/**
 * Classify one row.
 *
 * THE ORDER OF THE FOUR CASES IS LOAD-BEARING and matches the roster it came
 * from. Revoked beats everything, because a withdrawal is a decision somebody
 * made and should not be reported as mere elapsed time. Expiry beats
 * publication, so a link that ran out before its post went live reads `expired`
 * rather than `spent` — the two are only distinguishable here, and `expired` is
 * the one the operator can act on by extending.
 *
 * `spent` is a link whose row has not expired and has not been withdrawn, but
 * whose POST is already public. Nothing needs doing about one: the draft it was
 * minted to show is a page anybody can load, so it grants nothing a plain URL
 * doesn't. It is a distinct state rather than folded into `live` because
 * reporting it as live is what made the roster answer "what is outstanding?"
 * with "everything, forever".
 *
 * `pubDate` is nullable and a null is tolerated rather than refused. A link
 * minted against a post since renamed or deleted is exactly the one most in need
 * of revoking, so it has to remain listable; such a row simply reports its own
 * expiry with no publication in the picture.
 *
 * `extendTo` is present only where extending would actually do something. A
 * revoked link cannot be extended at all (extendLink's UPDATE requires
 * `revoked_at IS NULL`) and a spent one has nothing left to be extended to
 * (preview-extend refuses a published post outright) — in both cases the absence
 * of a date is the answer. The cap reported is the SIGNATURE ceiling or
 * PUBLICATION, whichever comes first, because that is what `just preview-extend`
 * will honour; reporting the raw ceiling would advertise headroom the clamp then
 * removes.
 *
 * AN EXPIRED LINK STILL HAS HEADROOM, and that is deliberate rather than an
 * oversight. extendLink's WHERE clause never looks at the current `exp`, only at
 * the ceiling, so a lapsed link can be wound forward and comes back to life on
 * the URL the reviewer already has. That is the recovery path for "their link
 * ran out over the weekend", and it is the whole reason extending beats
 * reminting. Do not narrow this to live links; it looks like tidying and it
 * removes the feature.
 *
 * The room is measured against BOTH where the link stands and now — `limit >
 * max(exp, now)`. Against `exp` alone (which is what the roster used to do) a
 * link that had expired and whose ceiling had ALSO passed advertised an extend
 * date in the past, because a dead ceiling is still later than an older dead
 * expiry. Against `now` alone, a live link sitting exactly at its cap would
 * advertise its own expiry as headroom. Both bounds are needed, and each one
 * catches a case the other does not.
 *
 * @param {{ exp: number, max_exp?: number, revoked_at?: number|null }} row
 *   as stored: `exp` and `max_exp` in epoch SECONDS, `revoked_at` in epoch MS.
 *   Each column matches the thing it mirrors — see migrations/0001.
 * @param {{ pubDate?: Date|null, now?: number }} [ctx] `now` is epoch MS,
 *   injected so the boundaries are testable.
 * @returns {LinkState}
 */
export function linkState(row, { pubDate = null, now = Date.now() } = {}) {
  const nowSec = Math.floor(now / 1000);
  const published = pubDate != null && isPublished(pubDate, now);
  const revoked = row.revoked_at != null;
  // Inclusive, matching isLinkActive's exclusive `exp * 1000 > now` from the
  // other side: at exactly `exp` the link is expired here and refused there.
  const expired = row.exp <= nowSec;

  const state = revoked ? 'revoked' : expired ? 'expired' : published ? 'spent' : 'live';

  // Only computed for a row extendLink would actually move — live or expired.
  // max_exp is absent on rows read before migrations/0002 existed anywhere;
  // treating that as no headroom is the fail-closed reading, and matches what
  // extendLink would do with a ceiling of 0.
  let extendTo = null;
  if (state === 'live' || state === 'expired') {
    const ceiling = row.max_exp ?? 0;
    const limit = pubDate == null ? ceiling : clampToPublication(ceiling, pubDate);
    if (limit > Math.max(row.exp, nowSec)) extendTo = new Date(limit * 1000);
  }

  return {
    state,
    live: state === 'live',
    expires: new Date(row.exp * 1000),
    revokedAt: revoked ? new Date(row.revoked_at) : null,
    publishedAt: state === 'spent' ? pubDate : null,
    extendTo,
  };
}
