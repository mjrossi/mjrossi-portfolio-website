// The <guid> of a post in /blog/rss.xml.
//
// Readers and Buttondown (an irreversible send) identify an item by its GUID.
// @astrojs/rss derives it from `site`, so a domain move would make every item
// look new and risk mailing the archive again. Pinned to the original origin
// instead; feed-guid.test.js holds the strings fixed.

export const GUID_ORIGIN = 'https://mjrossi.com';

/**
 * @param {string} slug  a post id, as `getPublishedPosts` returns it
 * @returns {string}
 */
export function feedGuid(slug) {
  return `${GUID_ORIGIN}/blog/${slug}/`;
}
