// What the Desk index shows, and in what order.
//
// Pure: posts, link rows and note counts in, a view model out. The Astro page
// does the two queries and the markup; every decision about what deserves to be
// on the page lives here, where `node --test` can reach it. Same split as
// galley-render.js, which owns what a pulled review file SAYS while
// galley-pull.mjs owns the I/O.
//
// The question this page answers is "what is outstanding?", and the hard part is
// that the answer is not "the scheduled posts". A round can outlive its draft:
// move a pubDate earlier, or publish while notes are still open, and the post is
// live with feedback nobody has closed. A link can outlive its post entirely —
// preview-roster grew `--all` because a link whose slug you have forgotten is
// otherwise unrevocable. Both belong on this page, so the row set is a union
// rather than a filter over the collection.

import { linkState } from './link-state.js';
import { isPublished } from './schedule.js';

/**
 * @typedef {object} DeskPost
 * @property {string} slug
 * @property {string} title
 * @property {Date} pubDate
 * @property {boolean} published
 * @property {number} liveLinks outstanding links — `live` only, so a spent or
 *   revoked one does not read as something to deal with.
 * @property {number} totalLinks every link ever minted for the post.
 * @property {number} openNotes
 */

/**
 * Assemble the index.
 *
 * A post earns a row by being scheduled, by having a live link, or by having an
 * open note. A published post with neither is deliberately absent: it is the
 * steady state of every post this blog has ever run, and listing them all would
 * bury the three that need something.
 *
 * ORDER IS BY URGENCY, NOT BY DATE. Scheduled posts come first, soonest
 * publication first, because publication is the deadline everything else hangs
 * off — a draft going live tomorrow with eleven open notes is the only row that
 * matters on that page. Everything else follows by open notes, then by slug so
 * the order is stable between loads.
 *
 * @param {{ posts: {slug: string, title: string, pubDate: Date}[],
 *           links?: Record<string, any>[],
 *           openNotes?: Map<string, number>,
 *           now?: number }} input
 * @returns {{ posts: DeskPost[],
 *             orphans: { slug: string, links: any[] }[],
 *             totals: { scheduled: number, liveLinks: number, openNotes: number } }}
 */
export function deskIndex({ posts, links = [], openNotes = new Map(), now = Date.now() } = {}) {
  const bySlug = new Map(posts.map((post) => [post.slug, post]));

  /** slug → its links, in the order listAllLinks returned them. */
  const linksBySlug = new Map();
  for (const link of links) {
    const bucket = linksBySlug.get(link.slug);
    if (bucket) bucket.push(link);
    else linksBySlug.set(link.slug, [link]);
  }

  const rows = [];
  for (const post of posts) {
    const own = linksBySlug.get(post.slug) ?? [];
    const published = isPublished(post.pubDate, now);
    const liveLinks = own.filter(
      (link) => linkState(link, { pubDate: post.pubDate, now }).live,
    ).length;
    const notes = openNotes.get(post.slug) ?? 0;

    // The union. A published post with nothing outstanding is not news.
    if (published && liveLinks === 0 && notes === 0) continue;

    rows.push({
      slug: post.slug,
      title: post.title,
      pubDate: post.pubDate,
      published,
      liveLinks,
      totalLinks: own.length,
      openNotes: notes,
    });
  }

  rows.sort((a, b) => {
    // Scheduled first, and among them the soonest deadline.
    if (a.published !== b.published) return a.published ? 1 : -1;
    if (!a.published) return a.pubDate.valueOf() - b.pubDate.valueOf();
    if (a.openNotes !== b.openNotes) return b.openNotes - a.openNotes;
    return a.slug.localeCompare(b.slug);
  });

  // Links pointing at a slug the collection does not have — a post renamed,
  // deleted, or never merged. These are exactly the links most in need of
  // revoking and the hardest to find, which is why preview-roster grew --all;
  // without a section here they would be invisible on the Desk for the same
  // reason.
  const orphans = [...linksBySlug.entries()]
    .filter(([slug]) => !bySlug.has(slug))
    .map(([slug, own]) => ({ slug, links: own }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    posts: rows,
    orphans,
    totals: {
      scheduled: rows.filter((row) => !row.published).length,
      // Counted over the ROWS, so this agrees with the numbers on screen. An
      // orphan link has no pubDate to classify against and is reported by its
      // own section rather than folded in here, where it would be a number
      // nothing on the page adds up to.
      liveLinks: rows.reduce((sum, row) => sum + row.liveLinks, 0),
      openNotes: rows.reduce((sum, row) => sum + row.openNotes, 0),
    },
  };
}
