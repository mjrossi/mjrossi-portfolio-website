// Scheduled publishing. Plain JS so `node --test` can reach it without
// `astro:content`; `now` is injectable so tests can pin the boundary.

/**
 * Is the post visible yet? Inclusive: visible at exactly `pubDate`.
 *
 * @param {Date} pubDate
 * @param {number} [now] epoch ms
 * @returns {boolean}
 */
export function isPublished(pubDate, now = Date.now()) {
  return pubDate.valueOf() <= now;
}

// ── publication as a bound on a preview link ─────────
//
// Once a post is public a preview link has nothing left to grant, so minting
// and extending cap a link's expiry at publication. CLI-side only, so
// src/lib/schedule.test.js is its only coverage.

/**
 * The instant a post goes live, as epoch SECONDS. Rounded UP so isPublished
 * (`<=`) and isLinkActive (`>`) hand over with no gap and no overlap.
 *
 * @param {Date} pubDate
 * @returns {number}
 */
export function publicationTime(pubDate) {
  return Math.ceil(pubDate.valueOf() / 1000);
}

/**
 * The earlier of a requested expiry and publication, as epoch SECONDS.
 *
 * Returns a past expiry for an already-published post; callers decide what that
 * means. Does not touch the signature ceiling, so a slipped launch still has
 * room for `just preview-extend --all`.
 *
 * @param {number} exp requested expiry, epoch seconds
 * @param {Date} pubDate
 * @returns {number}
 */
export function clampToPublication(exp, pubDate) {
  return Math.min(exp, publicationTime(pubDate));
}
