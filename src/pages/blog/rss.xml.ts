import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getPublishedPosts } from '../../lib/blog.ts';

export const prerender = true;

export async function GET(context: APIContext) {
  const posts = await getPublishedPosts();
  const site = context.site ?? new URL('https://mjrossi.com');

  return rss({
    title: 'The Urbanist Lexicon',
    description: 'A record of systems, movement, and the transition from bits to bricks.',
    site,
    items: posts.map((post) => ({
      title: post.data.title,
      description: post.data.description,
      pubDate: post.data.pubDate,
      link: `/blog/${post.id}/`,
    })),
    xmlns: { atom: 'http://www.w3.org/2005/Atom' },
    customData: [
      '<language>en-us</language>',
      `<atom:link href="${new URL('/blog/rss.xml', site).href}" rel="self" type="application/rss+xml" />`,
    ].join(''),
  });
}
