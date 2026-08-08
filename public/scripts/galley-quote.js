// Both directions of the galley's quote anchor: text → position, position → text.
//
// The galley anchors a note two ways (see src/lib/remark-source-anchors.js):
// the MDX line range of the block, and the quoted text plus context. The line
// range is what `markAnchors` uses to find the BLOCK. This module owns what
// happens inside it, in both directions:
//
//   anchorSelection  a selection → the quote, prefix and suffix stored on a note
//   findQuote        a stored quote → the exact characters to mark in the block
//
// THEY ARE INVERSES, and they live together for that reason. Each is a mapping
// between a position in the rendered text and a position in the collapsed text
// the other one reasons about; two files would let them drift a character apart
// and nothing would say so — the note would simply be filed against, or marked
// at, a passage one word off. `galley-quote.test.js` round-trips them.
//
// Split out of galley.js and unit-tested for the reason galley-relocate.js and
// galley-manifest.js were: a regression here is SILENT IN BOTH DIRECTIONS. Get
// the offset mapping wrong by a little and the highlight sits on the wrong
// words while looking entirely deliberate, or a note is stored describing prose
// the reviewer never selected — the same failure the pull script's "ambiguous
// matches resolve to nothing" rule exists to prevent, one layer up. Nothing
// else in this repo can catch that: there is no browser harness, and the
// server-side smoke assertions cannot see a pixel.
//
// The write side matters more than the read side, and that is why it is here.
// A bad marker shows the wrong colour until the page reloads; a bad anchor is
// written to D1 permanently, and `galley-pull.mjs` will relocate a note by its
// quote and context months later on the strength of it.
//
// Deliberately DOM-free. Every function takes the block's text nodes as an
// array of plain strings and works in offsets into their concatenation, so
// `node --test` can exercise every case without a document. galley.js does only
// the parts that need one: gather the nodes, measure where a selection starts,
// build the Range.
//
// Served as a static asset and imported by /scripts/galley.js at runtime, which
// is why it lives here rather than in src/lib/. Its tests live in
// src/lib/galley-quote.test.js: `npm test` globs src/, and a *.test.js next to
// this file would be served to the public along with it.

/**
 * The whitespace normalisation both sides of the search must agree on.
 *
 * This is the same fold `resolveSelection` applies when it records a quote, and
 * that is the whole point of exporting it — the quote in the database went
 * through this function in the browser, so the text we search has to as well.
 * `\s` covers U+00A0, which matters: `&nbsp;` reaches `textContent` verbatim
 * and would otherwise never match a quote containing an ordinary space.
 *
 * @param {string} text
 * @returns {string}
 */
export function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Index of `quote` in `blockText`, or -1 if it is absent OR ambiguous.
 *
 * Ambiguity resolves to nothing on purpose. A note stores prefix/suffix context
 * for exactly this case, but `GET /api/galley` does not return them — so when a
 * paragraph says "note" twice and a note quotes "note", there is no way to tell
 * which one was meant. Highlighting the first is a confident guess, and a
 * confident guess that lands on the wrong sentence is worse than no highlight:
 * the block marker still shows, so the reviewer is told there is a note here,
 * just not which words. Same stance as galley-relocate.js takes on the pull side.
 *
 * @param {string} blockText already collapsed
 * @param {string} quote already collapsed
 * @returns {number}
 */
export function locateQuote(blockText, quote) {
  if (!blockText || !quote) return -1;
  const first = blockText.indexOf(quote);
  if (first === -1) return -1;
  if (blockText.indexOf(quote, first + 1) !== -1) return -1;
  return first;
}

/**
 * Locate a quote across a block's text nodes.
 *
 * @param {string[]} texts the block's text nodes, in document order
 * @param {string | null | undefined} quote the note's stored quote
 * @returns {{ startIndex: number, startOffset: number, endIndex: number, endOffset: number } | null}
 *   coordinates in `texts`, with `endOffset` exclusive — ready to hand straight
 *   to `Range.setStart` / `Range.setEnd`. Null when the quote cannot be placed.
 */
export function findQuote(texts, quote) {
  if (!Array.isArray(texts) || typeof quote !== 'string') return null;
  const needle = collapse(quote);
  if (!needle) return null;

  const raw = texts.join('');
  const { collapsed, starts, ends } = index(raw);

  const at = locateQuote(collapsed, needle);
  if (at === -1) return null;

  const start = toNode(texts, starts[at], false);
  const end = toNode(texts, ends[at + needle.length - 1], true);
  if (!start || !end) return null;

  return {
    startIndex: start.index,
    startOffset: start.offset,
    endIndex: end.index,
    endOffset: end.offset,
  };
}

// ── the write side ─────────────────────────────────────

/**
 * Node coordinates → an offset into the concatenated raw text.
 *
 * The join between `findQuote`, which speaks in node coordinates because that
 * is what `Range` wants, and everything below, which speaks in raw offsets
 * because that is what a selection measures as. Exported so the round-trip test
 * can compose the two directions without a DOM.
 *
 * @returns {number} -1 for coordinates outside `texts`
 */
export function rawOffsetOf(texts, index_, offset) {
  if (!Array.isArray(texts)) return -1;
  if (!Number.isInteger(index_) || index_ < 0 || index_ >= texts.length) return -1;
  if (!Number.isInteger(offset) || offset < 0 || offset > texts[index_].length) return -1;
  return texts.slice(0, index_).join('').length + offset;
}

/**
 * A raw offset in the block → the offset of the same position in the COLLAPSED
 * text, which is the coordinate space quotes, prefixes and suffixes live in.
 *
 * This is the direction `findQuote` runs in reverse, and the asymmetry in it is
 * deliberate: leading whitespace is dropped but TRAILING whitespace is not.
 * This measures a position, not a string. A quote preceded by a space sits one
 * character further along the collapsed text than the word before it ends, and
 * `collapse`'s trim would lose exactly that character and report every such
 * anchor one short. The leading strip is needed for the opposite reason —
 * `block.textContent` routinely opens with the newline and indentation that
 * preceded it in the HTML, which `collapse` also drops, so a quote at the very
 * start of a block has to measure as 0.
 *
 * @returns {number} -1 when the position is unknown, which callers treat as
 *   "not measured" rather than as position zero.
 */
export function collapsedOffsetOf(texts, rawStart) {
  if (!Array.isArray(texts)) return -1;
  if (!Number.isInteger(rawStart) || rawStart < 0) return -1;
  return texts
    .join('')
    .slice(0, rawStart)
    .replace(/\s+/g, ' ')
    .replace(/^ /, '').length;
}

/**
 * A selection → the three things a note records about where it points.
 *
 * @param {string[]} texts the block's text nodes, in document order
 * @param {number} rawStart offset into their concatenation where the selection
 *   begins, or -1 if it could not be measured
 * @param {string} selected the raw selected text, as the browser reports it
 * @param {number} context how much text to keep either side
 * @returns {{ quote: string, prefix: string, suffix: string, at: number } | null}
 */
export function anchorSelection(texts, rawStart, selected, context = 32) {
  if (!Array.isArray(texts) || typeof selected !== 'string') return null;

  const raw = texts.join('');
  const blockText = collapse(raw);
  const measured = collapsedOffsetOf(texts, rawStart);

  let quote = collapse(selected);
  if (!quote) return null;

  let at = place(blockText, quote, measured);

  // A selection dragged across a block boundary yields text that appears in no
  // single block, so the quote would be unfindable and the context empty — and
  // the note would still save, looking correct to the editor and landing in the
  // review file as permanently unlocatable. Clamp to the part inside the block
  // the selection STARTED in, which is the block the anchor names.
  //
  // Only attempted when the start was measurable: without it there is nothing
  // to clamp FROM, and taking the whole block instead would file a note quoting
  // an entire paragraph the reviewer never selected.
  if (at === -1 && measured >= 0) {
    const inBlock = collapse(raw.slice(rawStart));
    if (inBlock) {
      quote = inBlock;
      // Clamping moved the END of the selection, never its start, so the
      // measured offset still holds — same preference and same fallback.
      at = place(blockText, quote, measured);
    }
  }

  // Still not placed (a selection starting inside a nested element whose text
  // does not appear verbatim in the block). Better no anchor than one that can
  // never be pointed at a passage.
  if (at === -1) return null;

  return {
    quote,
    prefix: blockText.slice(Math.max(0, at - context), at),
    suffix: blockText.slice(at + quote.length, at + quote.length + context),
    at,
  };
}

/**
 * Where the quote sits in the block: where the selection STARTED, not where its
 * text first happens to appear.
 *
 * `indexOf` alone would capture the context around the FIRST occurrence: an
 * editor selecting the second of two identical sentences in a block would get
 * prefix/suffix describing the first, and the pull script would then
 * "disambiguate" the note onto the wrong passage. That is precisely the
 * mis-anchoring prefix/suffix exist to prevent, so it must not be reintroduced.
 *
 * The measured offset is verified against the quote rather than trusted:
 * whitespace collapsing at the boundary can shift it by one, and a nested
 * element's text may not appear verbatim. `indexOf` remains the fallback — it
 * is right in every case except the repeated-text one above.
 */
function place(blockText, quote, measured) {
  if (measured >= 0 && blockText.slice(measured, measured + quote.length) === quote) return measured;
  return blockText.indexOf(quote);
}

/**
 * Collapse `raw` while recording, for every character of the result, the raw
 * span it came from.
 *
 * The collapsed string is built here rather than by calling `collapse(raw)`,
 * because the offsets have to be recorded in the same pass that produces it.
 * The two must stay in step; `galley-quote.test.js` pins that they do.
 *
 * A collapsed space stands for a whole whitespace run, so its span is wider
 * than one character — which is why the end of a match is looked up in `ends`
 * rather than computed as `start + length`. Quotes are trimmed on both sides so
 * a match never begins or ends on one of these, but the run still shifts every
 * offset after it.
 */
function index(raw) {
  const starts = [];
  const ends = [];
  let collapsed = '';
  let i = 0;

  // Leading whitespace is dropped rather than emitted, matching collapse()'s
  // trim. Raw offsets are NOT shifted by it — that is the entire reason this
  // mapping exists, since block.textContent routinely opens with the newline
  // and indentation that preceded the text in the HTML.
  while (i < raw.length && /\s/.test(raw[i])) i += 1;

  while (i < raw.length) {
    if (/\s/.test(raw[i])) {
      const runStart = i;
      while (i < raw.length && /\s/.test(raw[i])) i += 1;
      // A run at the very end is trailing whitespace: trim drops it too.
      if (i >= raw.length) break;
      collapsed += ' ';
      starts.push(runStart);
      ends.push(i);
    } else {
      collapsed += raw[i];
      starts.push(i);
      ends.push(i + 1);
      i += 1;
    }
  }

  return { collapsed, starts, ends };
}

/**
 * Raw offset over the concatenated text → the node holding it, and the offset
 * within that node.
 *
 * An offset landing exactly on a node boundary is two equivalent positions as
 * far as `Range` is concerned, and `closing` picks the tidier one: the END of
 * the node just before it for a range's end, the START of the node after it for
 * a range's start. Both encode the same selection, but the tight one keeps the
 * range from reaching into a neighbouring element to enclose nothing — a link
 * or an <em> immediately after the quoted words, say. Empty text nodes are
 * stepped over on the same argument.
 */
function toNode(texts, rawIndex, closing) {
  if (typeof rawIndex !== 'number') return null;
  let seen = 0;
  for (let i = 0; i < texts.length; i += 1) {
    const length = texts[i].length;
    if (closing && length > 0 && rawIndex === seen + length) return { index: i, offset: length };
    if (rawIndex < seen + length) return { index: i, offset: rawIndex - seen };
    seen += length;
  }
  // The very end of the block: clamp to the end of the last non-empty node.
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    if (texts[i].length > 0) return { index: i, offset: texts[i].length };
  }
  return null;
}
