/**
 * The archive as a sequence: which post a surface features, and which sit
 * either side of one. Plain functions over the sorted, newest-first list, so
 * `node --test` can state every case against `{ id }` stubs; blog.ts wraps them.
 */

/**
 * The permanently future-dated smoke fixture. It belongs in listings, but dated
 * 2099 it is the newest post wherever drafts are visible, so no surface may
 * FEATURE it. Declared here, once, so smoke can import it under bare Node.
 */
export const FIXTURE_SLUG = 'smoke-scheduled-fixture';

/** The sequence a reader actually travels: everything but the fixture. */
export const realPosts = (posts) => posts.filter((post) => post.id !== FIXTURE_SLUG);

/**
 * The chronological neighbours of a post. Newest-first, so `previous` (older)
 * is the NEXT index — named for the reader's direction, not the array's.
 *
 * Either can be null, and the caller renders nothing for it (see PostNav). A
 * post not in the list (a draft, in production) gets two nulls. The fixture is
 * excluded, or the newest real post's "Next →" pointed at it on preview hosts.
 */
export function adjacentIn(posts, id) {
  const list = realPosts(posts);
  const i = list.findIndex((post) => post.id === id);
  if (i === -1) return { previous: null, next: null };
  return {
    previous: list[i + 1] ?? null,
    next: list[i - 1] ?? null,
  };
}

/**
 * The newest posts that aren't the fixture. Where drafts are visible (preview
 * hosts, `astro dev`) that means the newest real drafts first.
 */
export function latestIn(posts, limit = 1) {
  return realPosts(posts).slice(0, limit);
}
