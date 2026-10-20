// What the Desk index shows, and in what order. Pure, so `node --test` reaches
// every decision; the page does the queries and the markup.
//
// "Outstanding" is not just "scheduled": a post can publish with notes still
// open, and a link can outlive its post. So the rows are a UNION, not a filter
// over the collection.

import { linkState } from './link-state.js';
import { isPublished } from './schedule.js';

/**
 * `1 open note` / `3 open notes`. Shared by both Desk pages.
 *
 * @param {number} n
 * @param {string} one singular noun
 * @param {string} [many] plural, when it is not the singular plus an s
 * @returns {string}
 */
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Midnight UTC on the day a date falls, as an epoch. */
const utcDay = (date) => Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());

/**
 * How long until a draft publishes.
 *
 * In CALENDAR DAYS (UTC), not elapsed time. Rounding the raw gap got the last
 * day wrong both ways: thirty minutes out read "tomorrow", twenty-five hours
 * out read "in 2 days". UTC because that is what `pubDate` and the date printed
 * beside it mean.
 *
 * @param {Date} pubDate
 * @param {number} [now] epoch MS
 * @returns {string}
 */
export function countdown(pubDate, now = Date.now()) {
  const days = Math.round((utcDay(pubDate) - utcDay(new Date(now))) / 86_400_000);
  if (days <= 0) return 'publishes today';
  if (days === 1) return 'publishes tomorrow';
  return `publishes in ${days} days`;
}

/**
 * @typedef {object} DeskPost
 * @property {string} slug
 * @property {string} title
 * @property {Date} pubDate
 * @property {boolean} published
 * @property {number} liveLinks `live` only
 * @property {number} totalLinks every link ever minted for the post.
 * @property {number} openNotes
 */

/**
 * Assemble the index.
 *
 * A post gets a row if it is scheduled, has a live link, or has an open note.
 * Ordered by urgency: scheduled first, soonest publication first; then by open
 * notes; then by slug for a stable order.
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
    if (a.published !== b.published) return a.published ? 1 : -1;
    if (!a.published) return a.pubDate.valueOf() - b.pubDate.valueOf();
    if (a.openNotes !== b.openNotes) return b.openNotes - a.openNotes;
    return a.slug.localeCompare(b.slug);
  });

  // Links for a slug the collection doesn't have (renamed, deleted, never
  // merged): the ones most in need of revoking, and otherwise invisible.
  const orphans = [...linksBySlug.entries()]
    .filter(([slug]) => !bySlug.has(slug))
    .map(([slug, own]) => ({ slug, links: own }))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  return {
    posts: rows,
    orphans,
    totals: {
      scheduled: rows.filter((row) => !row.published).length,
      // Over the rows, so it matches what is on screen; orphans have their own section.
      liveLinks: rows.reduce((sum, row) => sum + row.liveLinks, 0),
      openNotes: rows.reduce((sum, row) => sum + row.openNotes, 0),
    },
  };
}
