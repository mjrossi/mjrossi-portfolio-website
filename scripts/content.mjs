// Where a post's source lives on disk.
//
// scripts/preview-link.mjs validates a slug against real content before signing
// it — a typo would otherwise mint a perfectly valid link to a post that does
// not exist — and scripts/galley-pull.mjs reads the same file to hash and search
// it. Both need the same two-candidate probe, because a post is either
// <slug>.mdx or <slug>/index.mdx (the second form colocates images) and Astro
// derives the same slug from both.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

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
