// Scheduled-publishing predicate, extracted from src/lib/blog.ts so it can be
// unit-tested without pulling in `astro:content` (which only resolves inside
// Astro's build). Plain JS for the same reason as csp.js — vanilla Node
// imports it directly, no TypeScript tooling needed on the test side.
//
// `now` is injected rather than read from Date.now() inside so tests can pin
// the boundary. Callers in the app omit it.
//
// Boundary semantics: pubDate comes from `z.coerce.date()` on a bare
// YYYY-MM-DD in frontmatter, which yields midnight UTC on that day. The
// comparison is `<=`, so a post becomes visible exactly at 00:00:00.000 UTC
// on its pubDate — not a millisecond later. This is what CLAUDE.md documents.

/**
 * @param {Date} pubDate
 * @param {number} [now] epoch ms; defaults to the current time
 * @returns {boolean} true if the post should be visible
 */
export function isPublished(pubDate, now = Date.now()) {
  return pubDate.valueOf() <= now;
}

// ── publication as a bound on a preview link ─────────
//
// A preview link exists to show someone a post that isn't public yet. The moment
// it is public the link has nothing left to grant, so `just preview-link` and
// `just preview-extend` cap the row's expiry here rather than letting a spent
// link go on holding the galley open on a live post.
//
// This is minting policy and the deployed worker never calls it — but it lives
// beside isPublished because it answers the same question ("when does this post
// go live?") from the other side, and because that keeps both under `npm test`.
// The clamp is CLI-side, so smoke cannot reach it; these unit tests are the only
// coverage it will ever have.

/**
 * The instant a post goes live, as epoch SECONDS.
 *
 * Rounded UP, so the two comparisons hand over cleanly with neither a gap nor an
 * overlap: at exactly this second isPublished is true (it compares `<=`) while
 * isLinkActive is false (it compares `>`). Rounding down would expire the link
 * up to a second before the post appeared.
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
 * Callers must decide separately what to do about a post that has ALREADY
 * published — this returns a past expiry for one, which is a dead link rather
 * than an error. scripts/preview-link.mjs checks isPublished first and skips the
 * clamp, so minting a link for a live post (the documented local galley trial
 * loop) still works.
 *
 * Deliberately does NOT touch the signature ceiling. `max_exp` stays 30 days out
 * so that pushing a draft's pubDate back leaves headroom to extend into —
 * `just preview-extend <slug> --all` re-clamps every live link to the new date
 * without changing a single URL. Clamping the ceiling too would make a slipped
 * launch mean reminting every outstanding link, which is the exact problem
 * extending exists to remove.
 *
 * @param {number} exp requested expiry, epoch seconds
 * @param {Date} pubDate
 * @returns {number}
 */
export function clampToPublication(exp, pubDate) {
  return Math.min(exp, publicationTime(pubDate));
}
