// Stamps every commentable block with its MDX source lines, `<p data-src="42-47">`,
// so the galley can turn a browser selection back into a place in the .mdx.
//
// The line range is exact but goes stale on revision (notes also record the
// file's hash); the quote survives revision but can be ambiguous (notes also
// record its context). Together they degrade gracefully. See docs/GALLEY.md.
//
// Known limitation: MDX JSX elements (<Figure>, diagrams) carry no
// hProperties channel, so a note on a picture attaches to the adjacent
// paragraph.

/**
 * Blocks an editor would select text inside. Nesting is fine: the client's
 * `closest('[data-src]')` picks the innermost.
 */
const ANCHORED = new Set([
  'paragraph',
  'heading',
  'blockquote',
  'listItem',
  'code',
  'table',
]);

/**
 * Attach `data-src="<start>-<end>"`: 1-based, inclusive, as remark parsed the
 * file. The test pins the frontmatter offset, which would shift every anchor.
 *
 * @returns {(tree: object) => void}
 */
export default function remarkSourceAnchors() {
  return (tree) => {
    walk(tree, (node) => {
      if (!ANCHORED.has(node.type)) return;
      const start = node.position?.start?.line;
      const end = node.position?.end?.line;
      // No position: another plugin made it, so there is no range to point at.
      if (!Number.isInteger(start) || !Number.isInteger(end)) return;

      // Merge: another plugin may already have set hProperties.
      node.data ??= {};
      node.data.hProperties ??= {};
      node.data.hProperties['data-src'] = `${start}-${end}`;
    });
  };
}

/**
 * Depth-first walk. Hand-rolled because `unist-util-visit` is only a transitive
 * dependency, and hoisting is not a contract to rest anchors on.
 *
 * @param {object} node
 * @param {(node: object) => void} fn
 */
function walk(node, fn) {
  fn(node);
  const children = node.children;
  if (!Array.isArray(children)) return;
  for (const child of children) walk(child, fn);
}
