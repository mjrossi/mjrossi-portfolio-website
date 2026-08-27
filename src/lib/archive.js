/**
 * The archive as a sequence: which post a surface features, and which posts sit
 * either side of one.
 *
 * These take the already-sorted, newest-first list rather than fetching it, so
 * they are plain functions over an array — the same split as schedule.js and
 * link-state.js, and for the same reason. src/lib/blog.ts imports
 * `astro:content`, so `node --test` cannot load it, and until this module
 * existed the only coverage these decisions had was a live HTTP assertion in
 * scripts/smoke/live-preview.mjs that could ask its question of exactly one
 * post: the newest real one.
 *
 * That was the wrong shape twice over. It fused the invariant (the fixture is
 * never a neighbour) to a fact about the page's chrome (the newest real post
 * renders previous/next at all), and it read its subject out of whatever
 * src/content/blog held that month — so scheduling an ordinary post turned the
 * check red without the invariant moving. See archive.test.js, which states
 * every case against `{ id }` stubs, and blog.ts for the thin async wrappers.
 *
 * A post here is `{ id }` and nothing more. Nothing below reads `data`, which
 * is what lets the tests be three characters wide.
 */

/**
 * The permanently future-dated test fixture in src/content/blog/.
 *
 * It is a real entry in the collection and belongs in the listings — the whole
 * point of it is that `/blog`, RSS and the host unlock can be asserted against
 * something scheduled. What it must never be is a post a surface picks out to
 * feature, because its `pubDate` of 2099 makes it the newest post there is
 * wherever scheduled posts are visible at all.
 *
 * Declared here rather than in blog.ts so scripts/smoke/config.mjs can import
 * it: that module runs under bare node and could not reach `astro:content`, so
 * it re-declared the slug and scripts/smoke/static.mjs pinned the two copies
 * together with a source grep. One owner is better than a drift check.
 */
export const FIXTURE_SLUG = 'smoke-scheduled-fixture';

/** The sequence a reader actually travels: everything but the fixture. */
export const realPosts = (posts) => posts.filter((post) => post.id !== FIXTURE_SLUG);

/**
 * The chronological neighbours of a post (finding 1.5).
 *
 * No related-post logic: with an archive this size, "the one before and the one
 * after" is honest and needs no algorithm. The list is newest-first, so
 * `previous` (older) is the NEXT index and `next` (newer) is the previous one —
 * named for the reader's direction of travel through the archive, not for the
 * array's.
 *
 * Either can be null, and the caller renders that end as nothing at all — see
 * PostNav.astro for why a placeholder cell was worse than the gap. A post that
 * is its own neighbour is impossible because a slug appears once. A post the
 * list does not hold (a draft, on production) yields two nulls rather than
 * throwing — the route rendering it has already decided the reader may be there.
 *
 * The fixture is excluded for the same reason `latestIn` excludes it: dated
 * 2099, it is the newest entry wherever scheduled posts are visible, so on a
 * preview host the newest real post's "Next →" pointed at "Scheduled-post
 * fixture (not a real post)". A consequence worth naming: asked for the
 * fixture's OWN neighbours this returns two nulls, since it is absent from the
 * list it would look itself up in. That page is a test artifact and its
 * neighbours are not a thing anyone needs.
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
 * The posts a surface should feature — the newest ones that aren't the fixture.
 *
 * In production these are just the newest posts: the fixture is filtered out by
 * date long before it gets here. On a *.workers.dev preview host and in `astro
 * dev`, where scheduled posts ARE visible, the newest real drafts come first,
 * falling back to published posts when the fixture is the only scheduled one.
 */
export function latestIn(posts, limit = 1) {
  return realPosts(posts).slice(0, limit);
}
