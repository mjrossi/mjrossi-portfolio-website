import { getCollection, type CollectionEntry } from 'astro:content';
import { readingTime } from './readingTime.ts';

export type Post = CollectionEntry<'blog'>;

export const postReadingTime = (post: Post): string => readingTime(post.body ?? '').label;

export const dateFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

export const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export async function getPublishedPosts(): Promise<Post[]> {
  const posts = await getCollection('blog');
  return posts.sort((a, b) => b.data.pubDate.valueOf() - a.data.pubDate.valueOf());
}

export async function getAllTags(): Promise<string[]> {
  const posts = await getPublishedPosts();
  const tags = new Set<string>();
  for (const post of posts) {
    for (const tag of post.data.tags) tags.add(tag);
  }
  return [...tags].sort();
}

export async function getPostsByTag(tag: string): Promise<Post[]> {
  const posts = await getPublishedPosts();
  return posts.filter((p) => p.data.tags.includes(tag));
}
