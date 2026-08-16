import test from 'node:test';
import assert from 'node:assert/strict';

import { listPostSlugs, readPost } from '../../scripts/content.mjs';
import { RETIRED, retiredTarget, tagLabel } from './tags.js';

/**
 * Every tag in frontmatter across the collection.
 *
 * ENUMERATED THROUGH scripts/content.mjs, WHICH IS THE COPY THAT MIRRORS THE
 * LOADER. `node --test` cannot load astro:content, so this has to walk the
 * directory itself — and the walk is the part that rots. This used to be a
 * local scan that handled top-level `*.mdx` and `<dir>/index.mdx` only, which
 * is the exact shape 152e806 had just fixed one file over in listPostSlugs:
 * the glob is `**\/*.{md,mdx}`, so a `.md` post or one nested a directory
 * deeper is a real post that the scan could not see.
 *
 * That gap mattered more here than it did there. A post this missed got no OG
 * card — bad, and visible to a scraper. A post this misses is invisible to the
 * two assertions below, which are the ONLY enforcement of the working
 * vocabulary: a brand-new tag, or one the consolidation retired, would ride
 * into the collection in a `.md` post with the suite green and `RETIRED`
 * silently pointing at a live slug again. "A new tag fails that test" is the
 * documented contract, and it was true only for one of the loader's shapes.
 *
 * readPost parses with js-yaml rather than a regex over the raw `tags:` line,
 * so a block-style list counts too, and it throws on frontmatter that will not
 * parse instead of skipping the file — the right direction for a test.
 *
 * Cwd-relative, via content.mjs's CONTENT_DIR. `npm test` runs from the package
 * root, as does everything else that imports that module.
 */
function frontmatterTags() {
  const tags = new Set();
  for (const slug of listPostSlugs()) {
    const post = readPost(slug);
    for (const tag of post?.data?.tags ?? []) tags.add(tag);
  }
  return tags;
}

test('title-cases a slug for display', () => {
  assert.equal(tagLabel('advocacy'), 'Advocacy');
  assert.equal(tagLabel('safe-streets'), 'Safe Streets');
  assert.equal(tagLabel('urbanist-atlas'), 'Urbanist Atlas');
  assert.equal(tagLabel('artificial-intelligence'), 'Artificial Intelligence');
});

test('minor words stay lowercase, except in first position', () => {
  assert.equal(tagLabel('state-of-the-art'), 'State of the Art');
  assert.equal(tagLabel('the-lexicon'), 'The Lexicon');
});

test('a slug that was not retired has no target', () => {
  assert.equal(retiredTarget('advocacy'), null);
  assert.equal(retiredTarget('nonsense'), null);
  // Object.hasOwn, not `in` — otherwise every inherited key is a "retired tag".
  assert.equal(retiredTarget('constructor'), null);
  assert.equal(retiredTarget('toString'), null);
});

test('every retired tag redirects somewhere real', () => {
  const live = frontmatterTags();
  for (const [slug, target] of Object.entries(RETIRED)) {
    assert.ok(!live.has(slug), `${slug} is retired but still in frontmatter`);
    const tagTarget = /^\/blog\/tag\/([^/]+)$/.exec(target);
    if (tagTarget) {
      assert.ok(
        live.has(tagTarget[1]),
        `${slug} redirects to /blog/tag/${tagTarget[1]}, which no post carries — that is a 404 pointing at a 404`,
      );
    } else {
      assert.equal(target, '/blog', `${slug} redirects to an unexpected target ${target}`);
    }
  }
});

test('the working vocabulary is the consolidated set', () => {
  // Finding 2.1 cut thirteen tags to a working set. This pins it: a new tag is
  // a deliberate act, not something that accretes one post at a time.
  const expected = [
    'advocacy',
    'artificial-intelligence',
    'career',
    'cycling',
    'infrastructure',
    'personal',
    'smoke-fixture',
    'software-engineering',
    'transit',
    'urbanist-atlas',
  ];
  assert.deepEqual([...frontmatterTags()].sort(), expected);
});
