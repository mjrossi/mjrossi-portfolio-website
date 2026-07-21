import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getPublishedPosts } from '../../lib/blog.ts';

// On-demand (not prerendered): the feed is rebuilt per request so that
// scheduled posts (future pubDate) enter it automatically once their date
// passes — no redeploy needed — which keeps Buttondown's RSS-to-email and
// syndication pipeline working for scheduled publishing. `getPublishedPosts`
// applies the date filter in production.

export async function GET(context: APIContext) {
  // Only the host-based unlock reaches the feed. Signed preview links are
  // scoped to a single post's own URL and deliberately cannot inject a draft
  // here — this feed is what triggers Buttondown's email and social fan-out.
  const posts = await getPublishedPosts({ showScheduled: context.locals.showScheduled });
  const site = context.site ?? new URL('https://mjrossi.com');

  const response = await rss({
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

  // Middleware only sets Cache-Control on text/html responses, so set it
  // explicitly here to match the site's 1-hour edge-cache posture and keep
  // worker invocations cheap (a scheduled post still surfaces within the TTL).
  response.headers.set('Cache-Control', 'public, max-age=3600');
  return response;
}
