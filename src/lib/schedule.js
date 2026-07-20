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
