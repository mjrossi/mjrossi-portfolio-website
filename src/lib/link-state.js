// What a preview_links row means right now: live, expired, revoked, or spent.
//
// One classification for preview-roster, preview-extend and the Desk, so they
// cannot disagree about what is outstanding. Presentation stays with each caller.

import { clampToPublication, isPublished } from './schedule.js';

/**
 * @typedef {object} LinkState
 * @property {'live'|'expired'|'revoked'|'spent'} state
 * @property {boolean} live exactly `state === 'live'`: outstanding
 * @property {Date} expires the row's effective expiry
 * @property {Date|null} revokedAt for `revoked`
 * @property {Date|null} publishedAt for `spent`
 * @property {Date|null} extendTo how far `just preview-extend <id>` could move it,
 *   or null when that would do nothing
 */

/**
 * Classify one row.
 *
 * THE ORDER IS LOAD-BEARING. Revoked beats everything (a decision, not elapsed
 * time). Expired beats spent, because expired is the one the operator can act
 * on. Spent means the row is fine but the post is public, so it grants nothing;
 * counting it as live made the roster report everything as outstanding forever.
 *
 * A null `pubDate` is tolerated: a link for a renamed or deleted post is the one
 * most in need of revoking, so it must stay listable.
 *
 * `extendTo` is the signature ceiling or publication, whichever is first — what
 * preview-extend will actually honour.
 *
 * AN EXPIRED LINK STILL HAS HEADROOM, on purpose: extending by id revives it on
 * the URL the reviewer already has ("their link ran out over the weekend"). Do
 * not narrow that to live links. Only the bulk `--all` skips expired ones, since
 * a lapsed link may have been ended deliberately.
 *
 * Headroom is measured against both `exp` and now: `exp` alone advertised a past
 * date for a link whose ceiling had also passed; now alone advertised a link at
 * its cap as extendable.
 *
 * @param {{ exp: number, max_exp?: number, revoked_at?: number|null }} row
 *   `exp` / `max_exp` in epoch SECONDS, `revoked_at` in epoch MS
 * @param {{ pubDate?: Date|null, now?: number }} [ctx] `now` in epoch MS
 * @returns {LinkState}
 */
export function linkState(row, { pubDate = null, now = Date.now() } = {}) {
  const nowSec = Math.floor(now / 1000);
  const published = pubDate != null && isPublished(pubDate, now);
  const revoked = row.revoked_at != null;
  // At exactly `exp`: expired here, refused by isLinkActive.
  const expired = row.exp <= nowSec;

  const state = revoked ? 'revoked' : expired ? 'expired' : published ? 'spent' : 'live';

  // A missing max_exp (pre-migrations/0002) means no headroom.
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
