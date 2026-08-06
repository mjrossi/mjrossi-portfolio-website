// Where a post's source lives on disk.
//
// scripts/preview-link.mjs validates a slug against real content before signing
// it — a typo would otherwise mint a perfectly valid link to a post that does
// not exist — and scripts/galley-pull.mjs reads the same file to hash and search
// it. Both need the same two-candidate probe, because a post is either
// <slug>.mdx or <slug>/index.mdx (the second form colocates images) and Astro
// derives the same slug from both.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { coercePubDate } from '../src/lib/pubdate.js';

export const CONTENT_DIR = resolve('src/content/blog');

/**
 * Absolute path to the .mdx behind a slug, or null if there isn't one.
 *
 * Callers MUST shape-check the slug against SLUG_RE first. That check is what
 * keeps a `../` out of the paths built here; this function deliberately does
 * not repeat it, because the callers need to fail with their own message
 * explaining that preview tokens only carry lowercase-kebab slugs.
 *
 * @param {string} slug
 * @returns {string | null}
 */
export function resolvePostSource(slug) {
  return [
    resolve(CONTENT_DIR, `${slug}.mdx`),
    resolve(CONTENT_DIR, slug, 'index.mdx'),
  ].find(existsSync) ?? null;
}

/** The `---` fenced block at the top of an .mdx. */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/**
 * When a post goes live, read from its own frontmatter.
 *
 * `just preview-link` and `just preview-extend` cap a link's expiry at
 * publication, and `just preview-roster` reports a link as spent once the post is
 * out — all three need this, and all three run on a machine with the content
 * checked out, so there is no reason to store the date on the row.
 *
 * PARSED WITH js-yaml AND HANDED TO coercePubDate — the same two steps Astro's
 * loader and src/content.config.ts take, in the same order. That is the point:
 * a script and a build that disagreed about when a post publishes would mint
 * links expiring on the wrong day, and (for the quoted-timestamp case) the
 * disagreement would be a whole time zone wide with nothing to indicate it. Same
 * anti-drift argument as scripts/dev-vars.mjs, one layer up.
 *
 * js-yaml is a DIRECT dependency for this import. It resolves today only because
 * astro depends on it, which is the hoisting accident documented for
 * @astrojs/markdown-remark in CLAUDE.md; declaring it makes the resolution ours.
 *
 * Throws rather than returning null on a malformed date, because every caller
 * uses this to decide an expiry and none of them has a safe fallback.
 *
 * @param {string} slug
 * @returns {Date | null} null when the post has no source file
 */
export function readPubDate(slug) {
  const path = resolvePostSource(slug);
  if (!path) return null;

  const block = FRONTMATTER_RE.exec(readFileSync(path, 'utf8'));
  if (!block) throw new Error(`content: ${slug} has no frontmatter block`);

  let data;
  try {
    data = yaml.load(block[1]);
  } catch (err) {
    throw new Error(`content: could not parse the frontmatter of ${slug}: ${err.message}`);
  }

  const result = coercePubDate(data?.pubDate);
  if (!result.ok) throw new Error(`content: ${slug}: ${result.message}`);
  return result.date;
}
