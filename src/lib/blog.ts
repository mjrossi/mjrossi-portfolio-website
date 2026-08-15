import { getCollection, type CollectionEntry } from 'astro:content';
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
 * The permanently future-dated test fixture in src/content/blog/.
 *
 * It is a real entry in the collection and belongs in the listings — the whole
 * point of it is that `/blog`, RSS and the host unlock can be asserted against
 * something scheduled. What it must never be is the ONE post a surface picks
 * out to feature, because its `pubDate` of 2099 makes it the newest post there
 * is wherever scheduled posts are visible at all.
 *
 * `scripts/smoke/config.mjs` names the same slug (it can't import this module —
 * `astro:content` doesn't load under bare `node`), and smoke pins the two
 * against each other, the same way `WORKER_NAME` is pinned against
 * `wrangler.jsonc`.
 */
export const FIXTURE_SLUG = 'smoke-scheduled-fixture';

/**
 * The post a surface should feature — the newest one that isn't the fixture.
 *
 * In production this is just the newest post: the fixture is filtered out by
 * date long before it gets here. On a *.workers.dev preview host and in `astro
 * dev`, where scheduled posts ARE visible, this is the newest real draft, and
 * it falls back to the newest published post when the fixture is the only
 * scheduled one — which is the case today.
 */
export async function getLatestPost(opts: PostQuery = {}): Promise<Post | null> {
  const posts = await getPublishedPosts(opts);
  return posts.find((post) => post.id !== FIXTURE_SLUG) ?? null;
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
 * No related-post logic: with an archive this size, "the one before and the one
 * after" is honest and needs no algorithm. `getPublishedPosts` is newest-first,
 * so `previous` (older) is the NEXT index and `next` (newer) is the previous
 * one — named for the reader's direction of travel through the archive, not for
 * the array's.
 *
 * Both can be null, and the caller renders that as a filled cell rather than a
 * gap; a post that is its own neighbour is impossible because a slug appears
 * once. A post the query cannot see (a draft, on production) yields two nulls
 * rather than throwing — the route rendering it has already decided the reader
 * may be there.
 */
export async function getAdjacentPosts(
  id: string,
  opts: PostQuery = {},
): Promise<{ previous: Post | null; next: Post | null }> {
  const posts = await getPublishedPosts(opts);
  const i = posts.findIndex((p) => p.id === id);
  if (i === -1) return { previous: null, next: null };
  return {
    previous: posts[i + 1] ?? null,
    next: posts[i - 1] ?? null,
  };
}
