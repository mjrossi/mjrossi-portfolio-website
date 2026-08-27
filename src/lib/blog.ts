import { getCollection, type CollectionEntry } from 'astro:content';
import { adjacentIn, latestIn } from './archive.js';
import { readingTime } from './readingTime.js';
import { isPublished } from './schedule.js';

export type Post = CollectionEntry<'blog'>;

export const postReadingTime = (post: Post): string => readingTime(post.body ?? '').label;

export const dateFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Options for the listing helpers.
 *
 * `showScheduled` comes from `Astro.locals.showScheduled`, which middleware
 * sets true on *.workers.dev preview deploys. It is deliberately a plain
 * boolean: the per-post signed-link unlock (`locals.previewSlug`) is NOT
 * threaded through here, because these helpers back the blog index, tag pages,
 * and the RSS feed — and RSS drives Buttondown's email, an irreversible send to
 * real subscribers that a shareable preview link must never reach. The scoped
 * unlock is handled in src/pages/blog/[...slug].astro alone.
 */
export type PostQuery = { showScheduled?: boolean };

export async function getPublishedPosts(opts: PostQuery = {}): Promise<Post[]> {
  const posts = await getCollection('blog');
  // Scheduled publishing: in production, a post with a future pubDate stays
  // hidden until that date passes — from the index, tag pages, its direct URL
  // (which 404s), and the RSS feed, all of which flow through this function.
  //
  // Two escapes. In dev (`astro dev`) future posts stay visible so the author
  // can preview them; `import.meta.env.PROD` is inlined by Vite at build, so
  // that arm is a compile-time constant in the deployed worker. And on
  // *.workers.dev preview deploys, middleware passes showScheduled: true so a
  // PR branch shows its own drafts.
  //
  // The default is `{}` → hidden, so a call site that forgets to pass the flag
  // fails closed. The predicate lives in schedule.js so it can be unit-tested
  // without astro:content — see src/lib/schedule.test.js.
  const showAll = !import.meta.env.PROD || opts.showScheduled === true;
  const visible = showAll ? posts : posts.filter((post) => isPublished(post.data.pubDate));
  return visible.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export async function getAllTags(opts: PostQuery = {}): Promise<string[]> {
  const posts = await getPublishedPosts(opts);
  const tags = new Set<string>();
  for (const post of posts) {
    for (const tag of post.data.tags) tags.add(tag);
  }
  return [...tags].sort();
}

export async function getPostsByTag(tag: string, opts: PostQuery = {}): Promise<Post[]> {
  const posts = await getPublishedPosts(opts);
  return posts.filter((p) => p.data.tags.includes(tag));
}

/**
 * Re-exported so a call site reading the collection has one import, not two.
 * Owned by archive.js — see there for why the slug is declared in plain JS.
 */
export { FIXTURE_SLUG } from './archive.js';

/**
 * The posts a surface should feature — the newest ones that aren't the fixture.
 * `latestIn` owns the rule and is unit-tested; this is the fetch in front of it.
 */
export async function getLatestPosts(limit = 1, opts: PostQuery = {}): Promise<Post[]> {
  return latestIn(await getPublishedPosts(opts), limit);
}

/**
 * Every tag with its post count, for the topic index (/blog/tags).
 *
 * Ordered the way the index reads: most-used first, then alphabetically, so
 * ties don't shuffle between renders. Counts come from the same
 * getPublishedPosts as everything else, which is what keeps a scheduled post
 * from showing up as a +1 next to a topic whose page would 404 for it.
 */
export async function getTagCounts(opts: PostQuery = {}): Promise<{ tag: string; count: number }[]> {
  const posts = await getPublishedPosts(opts);
  const counts = new Map<string, number>();
  for (const post of posts) {
    for (const tag of post.data.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * The chronological neighbours of a post (finding 1.5).
 *
 * `adjacentIn` owns the rule — the direction of `previous`/`next`, the two ends,
 * a post the query cannot see, and the fixture's exclusion — and is unit-tested
 * in archive.test.js. This is the fetch in front of it.
 */
export async function getAdjacentPosts(
  id: string,
  opts: PostQuery = {},
): Promise<{ previous: Post | null; next: Post | null }> {
  return adjacentIn(await getPublishedPosts(opts), id);
}
