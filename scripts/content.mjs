// Where a post's source lives on disk, probed the way the content collection
// finds it: <slug>.mdx, <slug>/index.mdx, and the .md forms the glob accepts.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseFrontmatter } from '@astrojs/internal-helpers/frontmatter';
import { coercePubDate } from '../src/lib/pubdate.js';

export const CONTENT_DIR = resolve('src/content/blog');

/** The loader's glob, as a test on one filename: `**\/*.{md,mdx}`. */
const POST_FILE_RE = /\.mdx?$/;

/**
 * Every post slug on disk, exactly as the collection enumerates them. MIRRORS
 * BOTH the glob (`**\/*.{md,mdx}`, recursive) and `generateId` in
 * src/content.config.ts: make-post-og.mjs enumerates through here, so a shape
 * this misses is a post whose og:image 404s, silently. A folder with no post
 * file is images-only and contributes nothing.
 *
 * @returns {string[]} ids, `/`-separated, in the loader's own shape
 */
export function listPostSlugs() {
  const slugs = [];

  const walk = (dir, prefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        walk(resolve(dir, entry.name), `${prefix}${entry.name}/`);
      } else if (POST_FILE_RE.test(entry.name)) {
        const id = `${prefix}${entry.name}`.replace(/(?:\/index)?\.mdx?$/, '');
        // Root `index.mdx` collapses to ''; content.config.ts refuses it.
        if (id && id !== 'index') slugs.push(id);
      }
    }
  };

  walk(CONTENT_DIR, '');
  return slugs.sort();
}

/**
 * Absolute path to the .mdx behind a slug, or null. Callers MUST shape-check
 * the slug first; that is what keeps `../` out.
 *
 * @param {string} slug
 * @returns {string | null}
 */
export function resolvePostSource(slug) {
  return [
    resolve(CONTENT_DIR, `${slug}.mdx`),
    resolve(CONTENT_DIR, `${slug}.md`),
    resolve(CONTENT_DIR, slug, 'index.mdx'),
    resolve(CONTENT_DIR, slug, 'index.md'),
  ].find(existsSync) ?? null;
}

/**
 * When a post goes live, from its own frontmatter: Astro's `parseFrontmatter`
 * then `coercePubDate`, the same two steps as the build. Throws on a malformed
 * date — every caller decides an expiry from it, with no safe fallback.
 *
 * @param {string} slug
 * @returns {Date | null} null when the post has no source file
 */
export function readPubDate(slug) {
  return readPost(slug)?.pubDate ?? null;
}

/**
 * Frontmatter + body for a post, or null when there is no source file.
 *
 * @param {string} slug
 * @returns {{ path: string, data: Record<string, unknown>, pubDate: Date, body: string } | null}
 */
export function readPost(slug) {
  const path = resolvePostSource(slug);
  if (!path) return null;

  const source = readFileSync(path, 'utf8');
  let parsed;
  try {
    parsed = parseFrontmatter(source);
  } catch (err) {
    throw new Error(`content: could not parse the frontmatter of ${slug}: ${err.message}`);
  }
  if (!parsed.rawFrontmatter) throw new Error(`content: ${slug} has no frontmatter block`);
  const data = parsed.frontmatter;

  const result = coercePubDate(data?.pubDate);
  if (!result.ok) throw new Error(`content: ${slug}: ${result.message}`);

  return { path, data, pubDate: result.date, body: parsed.content };
}
