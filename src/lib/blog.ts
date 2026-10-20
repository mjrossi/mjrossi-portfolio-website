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
 * `showScheduled` is true on *.workers.dev preview deploys. Deliberately a plain
 * boolean: the per-post signed-link unlock (`previewSlug`) must NOT reach these
 * helpers, which back the index, tag pages and RSS — and RSS drives Buttondown's
 * irreversible email. That unlock lives in [...slug].astro alone.
 */
export type PostQuery = { showScheduled?: boolean };

export async function getPublishedPosts(opts: PostQuery = {}): Promise<Post[]> {
  const posts = await getCollection('blog');
  // In production a future pubDate hides the post everywhere that flows through
  // here: index, tag pages, its URL and RSS. Visible in `astro dev` (PROD is a
  // build-time constant) and on preview hosts. `{}` → hidden, so a call site
  // that forgets the flag fails closed.
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

/** Re-exported for one import; owned by archive.js. */
export { FIXTURE_SLUG } from './archive.js';

/** See latestIn. */
export async function getLatestPosts(limit = 1, opts: PostQuery = {}): Promise<Post[]> {
  return latestIn(await getPublishedPosts(opts), limit);
}

/**
 * Every tag with its post count, for /blog/tags: most-used first, then
 * alphabetical. From getPublishedPosts, so a draft never adds a +1.
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

/** See adjacentIn. */
export async function getAdjacentPosts(
  id: string,
  opts: PostQuery = {},
): Promise<{ previous: Post | null; next: Post | null }> {
  return adjacentIn(await getPublishedPosts(opts), id);
}
