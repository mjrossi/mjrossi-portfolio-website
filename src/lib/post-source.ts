// The raw .mdx of every post, and the revision hash derived from it.
//
// /api/galley and BlogPost.astro must compute the hash identically or every
// write is refused, so the glob and the slug rule live here once.
//
// Cost: every post's raw MDX is inlined into the worker (~84KB for 7 posts).
// Precomputing hashes at build time would need a generator that hashes
// byte-for-byte what sha256Hex does — a new way to drift. Revisit past a few
// dozen posts.

import { sha256Hex } from './galley.js';

const RAW_POSTS = import.meta.glob('/src/content/blog/**/*.mdx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Raw .mdx by slug, deriving the slug the way Astro derives an entry id:
 * `foo.mdx` and `foo/index.mdx` are both `foo`. Private on purpose.
 */
const SOURCE_BY_SLUG = new Map<string, string>(
  Object.entries(RAW_POSTS).map(([path, raw]) => {
    const rel = path.replace('/src/content/blog/', '').replace(/\.mdx$/, '');
    return [rel.endsWith('/index') ? rel.slice(0, -'/index'.length) : rel, raw];
  }),
);

/**
 * The raw .mdx for one post, or undefined. For the Desk, whose review model
 * works in source lines.
 *
 * Returns UNPUBLISHED drafts, so keep its only callers under /admin.
 */
export function sourceOf(slug: string): string | undefined {
  return SOURCE_BY_SLUG.get(slug);
}

const REVISIONS = new Map<string, Promise<string>>();

/**
 * SHA-256 of the ENTIRE .mdx (see galley.js), or undefined for no post. Always
 * computed here, never trusted from a client.
 *
 * Memoised per isolate — the sources are build-time constants — and the
 * promise is cached, so concurrent callers share one digest.
 */
export function revisionOf(slug: string): Promise<string | undefined> {
  const source = SOURCE_BY_SLUG.get(slug);
  if (source === undefined) return Promise.resolve(undefined);
  let hash = REVISIONS.get(slug);
  if (hash === undefined) {
    hash = sha256Hex(source);
    REVISIONS.set(slug, hash);
  }
  return hash;
}
