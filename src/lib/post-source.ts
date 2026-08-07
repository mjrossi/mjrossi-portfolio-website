// The raw .mdx of every post, and the revision hash derived from it.
//
// TWO CALLERS THAT MUST AGREE. src/pages/api/galley.ts stamps a note with the
// revision it was written against and refuses a note submitted from a page that
// has since moved; src/layouts/BlogPost.astro stamps that same revision onto the
// page so the client has something to submit. If those two computed the hash
// differently — a different glob, a different slug rule, a different encoding —
// every write would be refused and the galley would look broken.
//
// So the glob and the slug derivation live here once. Same anti-drift rationale
// as scripts/content.mjs on the CLI side, which exists so a minting script and
// the build cannot disagree about when a post publishes.
//
// COST, inherited from the endpoint this was extracted from and unchanged by the
// move: this inlines every post's raw MDX into the worker bundle — ~84KB across
// 7 posts, growing linearly — when all either caller needs is a slug→hash map.
// Precomputing that at build time would take a Vite plugin or a generator step,
// plus a guarantee that it hashes byte-for-byte what `sha256Hex` would, which is
// a new way for the drift warning to go silently wrong. Not worth it at this
// size. Revisit past a few dozen posts, or sooner if the worker bundle starts
// mattering for cold starts.
//
// Vite resolves an identical eager glob once per bundle, so importing this from
// both the endpoint and the layout does not duplicate the strings.

import { sha256Hex } from './galley.js';

const RAW_POSTS = import.meta.glob('/src/content/blog/**/*.mdx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/**
 * Raw .mdx by slug.
 *
 * '/src/content/blog/why-im-pivoting.mdx'  → 'why-im-pivoting'
 * '/src/content/blog/some-post/index.mdx'  → 'some-post'
 *
 * Mirrors how Astro's content collection derives an entry id from its path, so a
 * slug that reaches here from a signed grant (which carries a collection id)
 * finds the file it names.
 *
 * NOT exported: `revisionOf` below is the only thing either caller needs, and
 * handing out a map of every post's entire raw source is standing API surface
 * for a caller this module exists to make unnecessary.
 */
const SOURCE_BY_SLUG = new Map<string, string>(
  Object.entries(RAW_POSTS).map(([path, raw]) => {
    const rel = path.replace('/src/content/blog/', '').replace(/\.mdx$/, '');
    return [rel.endsWith('/index') ? rel.slice(0, -'/index'.length) : rel, raw];
  }),
);

/**
 * The revision hash for one post: SHA-256 of the ENTIRE .mdx, frontmatter
 * included, lowercase hex. `undefined` for a slug with no post.
 *
 * The whole file is hashed rather than the body because anchors are absolute
 * line numbers — adding one frontmatter tag shifts every one of them while
 * leaving the prose untouched, and a body-only hash would call that "unchanged".
 * See src/lib/galley.js.
 *
 * Computed here rather than trusted from a client for the write path: a browser
 * has no way to know the file's bytes, and a note that misreported which
 * revision it was written against would defeat the drift warning it exists to
 * raise. What the client sends is only ever compared against this, never stored.
 *
 * Memoised, because the sources are build-time constants inlined into the
 * bundle: a slug's hash cannot change for the life of an isolate, and this is
 * called on every review render, on every GET (which the margin now issues on
 * each tab focus), and on every POST. The PROMISE is cached rather than the
 * string, so concurrent callers share one digest instead of racing to compute
 * the same one.
 */
const REVISIONS = new Map<string, Promise<string>>();

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
