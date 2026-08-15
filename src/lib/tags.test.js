import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { RETIRED, retiredTarget, tagLabel } from './tags.js';

const BLOG_DIR = new URL('../content/blog/', import.meta.url).pathname;

/** Every tag in frontmatter across the collection. Deliberately a crude scan —
 *  `node --test` cannot load astro:content, and the shape being asserted is
 *  exactly the one line this reads. */
function frontmatterTags() {
  const files = [];
  for (const entry of readdirSync(BLOG_DIR)) {
    const path = join(BLOG_DIR, entry);
    if (statSync(path).isDirectory()) files.push(join(path, 'index.mdx'));
    else if (entry.endsWith('.mdx')) files.push(path);
  }
  const tags = new Set();
  for (const file of files) {
    const line = /^tags:\s*\[(.*)\]\s*$/m.exec(readFileSync(file, 'utf8'));
    if (!line) continue;
    for (const raw of line[1].split(',')) {
      const tag = raw.trim().replace(/^["']|["']$/g, '');
      if (tag) tags.add(tag);
    }
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
