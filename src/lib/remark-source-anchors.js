// Stamps every commentable block with the MDX source lines it came from, so
// the galley (inline editorial review — see CLAUDE.md) can turn a text
// selection in the browser back into a location in the .mdx file.
//
// A paragraph starting on line 42 and ending on line 47 renders as
// `<p data-src="42-47">`. The review client walks up from the selection to the
// nearest `[data-src]` and sends that range along with the selected text and
// ~32 characters of surrounding context.
//
// Both halves are needed and neither is sufficient:
//
//   - The line range is exact and cheap to apply, but it goes stale the moment
//     the post is revised — which is the normal case, since review happens in
//     rounds. Notes therefore also record a hash of the file, and the pull
//     script flags any note whose hash no longer matches.
//   - The quoted text survives revision, but on a 2,500-word post a bare quote
//     is ambiguous and a fuzzy match can land in the wrong section.
//
// Together they degrade gracefully: while the file is unchanged the line range
// applies mechanically, and once it drifts the quote plus context still
// identifies the passage.
//
// Plain JS for the same reason as csp.js, schedule.js, and preview.js — it is
// imported by astro.config.mjs and by `node --test` without TypeScript tooling
// on either side.
//
// KNOWN LIMITATION: `mdxJsxFlowElement` nodes carry no `data.hProperties`
// channel through the MDX pipeline, so <Figure> and the components in
// components/diagrams/ are not anchorable. An editor cannot attach a note to a
// diagram; they comment on the adjacent paragraph instead. Anchoring those
// would mean each component accepting and spreading a data attribute, which is
// a lot of surface area for the rare case of a note about a picture.

/**
 * Node types that get an anchor.
 *
 * Deliberately the blocks an editor would actually select text inside. Nesting
 * is fine and desirable: a `listItem` and the `paragraph` inside it both get
 * anchors, and the client's `closest('[data-src]')` naturally resolves to the
 * innermost — the more precise of the two.
 *
 * `thematicBreak` and `table` cells are excluded: there is no prose in them to
 * quote, so an anchor would only ever produce a note with an empty selection.
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
 * Attach `data-src="<startLine>-<endLine>"` to each anchorable block.
 *
 * Line numbers are 1-based and inclusive on both ends, matching what every
 * editor and `sed -n 'A,Bp'` expect. They are positions in the .mdx file as
 * remark parsed it — see the test for the frontmatter-offset case, which is
 * the one that would silently shift every anchor if it ever changed.
 *
 * @returns {(tree: object) => void}
 */
export default function remarkSourceAnchors() {
  return (tree) => {
    walk(tree, (node) => {
      if (!ANCHORED.has(node.type)) return;
      const start = node.position?.start?.line;
      const end = node.position?.end?.line;
      // A node without position came from another plugin rather than from the
      // file, so there is no source range to point at. Skip it rather than
      // emitting a bogus anchor the pull script would later trust.
      if (!Number.isInteger(start) || !Number.isInteger(end)) return;

      // Merge rather than assign: another plugin may already have set
      // hProperties, and clobbering it would drop whatever it configured.
      node.data ??= {};
      node.data.hProperties ??= {};
      node.data.hProperties['data-src'] = `${start}-${end}`;
    });
  };
}

/**
 * Depth-first walk over an mdast tree.
 *
 * Hand-rolled rather than pulling in `unist-util-visit`: that package is
 * present only as a transitive dependency of remark, and npm hoisting is not a
 * contract we want an anchor's correctness to rest on. The traversal this
 * needs is ten lines and has no ordering subtleties.
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
