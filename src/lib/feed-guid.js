// The <guid> of a post in /blog/rss.xml.
//
// A feed reader — and Buttondown, whose RSS-to-email is an irreversible send to
// real subscribers — identifies an item by its GUID. @astrojs/rss defaults the
// GUID to the item's absolute link, which is built from `site`, so changing the
// blog's domain (urbanistlexicon.com is on the table) would change every GUID
// at once and risk the whole archive being mailed again as new.
//
// So the GUID is pinned here to the origin every existing item was first
// published under, and never derived from `site`. These are exactly the strings
// the feed served before this module existed, so introducing it changed nothing
// on the wire; `feed-guid.test.js` holds them fixed. If the blog moves, these
// stay put — and they remain valid permalinks, since mjrossi.com/blog/* would
// redirect to the new home.
//
// Plain JS so `node --test` reaches it without the Astro toolchain.

export const GUID_ORIGIN = 'https://mjrossi.com';

/**
 * @param {string} slug  a post id, as `getPublishedPosts` returns it
 * @returns {string}
 */
export function feedGuid(slug) {
  return `${GUID_ORIGIN}/blog/${slug}/`;
}
