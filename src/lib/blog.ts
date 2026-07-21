import { getCollection, type CollectionEntry } from 'astro:content';
import { readingTime } from './readingTime.ts';
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
 * and the RSS feed — and RSS drives Buttondown's email + social syndication,
 * which a shareable preview link must never be able to reach. The scoped
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
