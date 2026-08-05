// Unit tests for the galley's source-anchor plugin. Run via `npm test`.
//
// These build mdast trees by hand rather than parsing markdown, so the tests
// stay free of remark — which is present only as a transitive dependency and
// so is not something a test's correctness should rest on.
//
// The one thing they deliberately do NOT cover is whether remark's line
// numbers include the frontmatter block. That is a property of the Astro
// pipeline rather than of this plugin, and getting it wrong would shift every
// anchor by a constant without failing anything here. smoke.mjs pins it
// end-to-end instead, by reading an anchor out of served HTML and checking the
// line it names in the .mdx actually holds the quoted text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import remarkSourceAnchors from './remark-source-anchors.js';

/** Apply the plugin to a tree, in place, and hand it back. */
function stamp(tree) {
  remarkSourceAnchors()(tree);
  return tree;
}

/** An mdast node with a position spanning `start`..`end`. */
function node(type, start, end = start, extra = {}) {
  return {
    type,
    position: { start: { line: start, column: 1 }, end: { line: end, column: 1 } },
    ...extra,
  };
}

const anchorOf = (n) => n.data?.hProperties?.['data-src'];

test('a paragraph is anchored to its source lines', () => {
  const p = node('paragraph', 8);
  stamp({ type: 'root', children: [p] });
  assert.equal(anchorOf(p), '8-8');
});

test('a multi-line block records both ends inclusively', () => {
  const p = node('paragraph', 42, 47);
  stamp({ type: 'root', children: [p] });
  assert.equal(anchorOf(p), '42-47');
});

test('headings, blockquotes, code, lists and tables are all anchorable', () => {
  const nodes = ['heading', 'blockquote', 'code', 'listItem', 'table'].map((t) => node(t, 3));
  stamp({ type: 'root', children: nodes });
  for (const n of nodes) {
    assert.equal(anchorOf(n), '3-3', `${n.type} should be anchored`);
  }
});

test('inline and structural nodes are not anchored', () => {
  // Anchoring these would produce notes with no quotable prose in them.
  const nodes = ['text', 'emphasis', 'thematicBreak', 'list'].map((t) => node(t, 3));
  stamp({ type: 'root', children: nodes });
  for (const n of nodes) {
    assert.equal(anchorOf(n), undefined, `${n.type} should not be anchored`);
  }
});

test('the root is not anchored', () => {
  const tree = stamp({ type: 'root', position: { start: { line: 1 }, end: { line: 99 } }, children: [] });
  assert.equal(anchorOf(tree), undefined);
});

test('nested blocks are each anchored, innermost included', () => {
  // The client resolves a selection with closest('[data-src]'), so the inner
  // paragraph must carry its own anchor — otherwise a note inside a list item
  // would resolve to the whole item and lose precision.
  const inner = node('paragraph', 5);
  const item = node('listItem', 4, 6, { children: [inner] });
  stamp({ type: 'root', children: [item] });
  assert.equal(anchorOf(item), '4-6');
  assert.equal(anchorOf(inner), '5-5');
});

test('a node with no position is skipped rather than given a bogus anchor', () => {
  // Nodes synthesised by another plugin have no source range. Emitting one
  // anyway would hand the pull script a line number pointing at unrelated text.
  const p = { type: 'paragraph' };
  stamp({ type: 'root', children: [p] });
  assert.equal(anchorOf(p), undefined);
});

test('a partial position is skipped', () => {
  const p = { type: 'paragraph', position: { start: { line: 4 } } };
  stamp({ type: 'root', children: [p] });
  assert.equal(anchorOf(p), undefined);
});

test('existing hProperties are preserved', () => {
  const p = node('paragraph', 8, 8, { data: { hProperties: { className: ['lede'] } } });
  stamp({ type: 'root', children: [p] });
  assert.deepEqual(p.data.hProperties, { className: ['lede'], 'data-src': '8-8' });
});

test('other data keys are preserved', () => {
  const p = node('paragraph', 8, 8, { data: { hName: 'section' } });
  stamp({ type: 'root', children: [p] });
  assert.equal(p.data.hName, 'section');
  assert.equal(anchorOf(p), '8-8');
});

test('deeply nested prose is reached', () => {
  const deep = node('paragraph', 12);
  const tree = {
    type: 'root',
    children: [node('blockquote', 10, 14, { children: [node('list', 11, 13, { children: [node('listItem', 11, 13, { children: [deep] })] })] })],
  };
  stamp(tree);
  assert.equal(anchorOf(deep), '12-12');
});
