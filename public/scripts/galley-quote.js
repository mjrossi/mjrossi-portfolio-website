// Both directions of the galley's quote anchor:
//
//   anchorSelection  a selection → the quote, prefix and suffix stored on a note
//   findQuote        a stored quote → the exact characters to mark
//
// THEY ARE INVERSES and live together so they cannot drift a character apart;
// galley-quote.test.js round-trips them. A regression is silent both ways: a
// highlight on the wrong words, or — worse, because it is written to D1 for
// good — a note describing prose nobody selected.
//
// DOM-free: functions take the block's text nodes as strings and work in
// offsets into their concatenation. Lives in public/ because galley.js imports
// it at runtime; its test is in src/lib/ so it isn't served.

/**
 * The whitespace fold both sides must agree on. `\s` covers U+00A0, which
 * `&nbsp;` leaves in textContent.
 *
 * @param {string} text
 * @returns {string}
 */
export function collapse(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * Index of `quote` in `blockText`, or -1 if absent OR ambiguous. GET
 * /api/galley doesn't return prefix/suffix, so a repeated quote can't be told
 * apart, and a confident wrong highlight is worse than the block marker.
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
 * Node coordinates → an offset into the joined raw text. Exported so the
 * round-trip test can compose both directions.
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
 * A raw offset → the same position in the COLLAPSED text, where quotes live.
 *
 * Deliberately asymmetric: leading whitespace is dropped (textContent opens
 * with the HTML's indentation, so a quote at the start must measure 0), but
 * trailing is kept — this measures a position, and trimming would report every
 * anchor after a space one short.
 *
 * @returns {number} -1 when unknown, never "position zero"
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

  // A selection across a block boundary matches no block and would save as
  // permanently unlocatable. Clamp to the block it STARTED in — only when the
  // start was measured, or this would quote a whole paragraph nobody selected.
  if (at === -1 && measured >= 0) {
    const inBlock = collapse(raw.slice(rawStart));
    if (inBlock) {
      quote = inBlock;
      // Only the end moved, so the measured start still holds.
      at = place(blockText, quote, measured);
    }
  }

  // Still unplaced: no anchor beats one that can never point at a passage.
  if (at === -1) return null;

  return {
    quote,
    prefix: blockText.slice(Math.max(0, at - context), at),
    suffix: blockText.slice(at + quote.length, at + quote.length + context),
    at,
  };
}

/**
 * Where the quote sits: where the selection STARTED, not its first occurrence.
 * `indexOf` alone would give the second of two identical sentences the first
 * one's context, and the pull would then disambiguate it onto the wrong one.
 * The measured offset is verified, not trusted; `indexOf` is the fallback.
 */
function place(blockText, quote, measured) {
  if (measured >= 0 && blockText.slice(measured, measured + quote.length) === quote) return measured;
  return blockText.indexOf(quote);
}

/**
 * Collapse `raw`, recording each result character's raw span in the same pass
 * (the test pins that this matches collapse()). A collapsed space spans a whole
 * run, which is why a match's end comes from `ends`, not `start + length`.
 */
function index(raw) {
  const starts = [];
  const ends = [];
  let collapsed = '';
  let i = 0;

  // Leading whitespace is dropped, as collapse() trims; raw offsets are not shifted.
  while (i < raw.length && /\s/.test(raw[i])) i += 1;

  while (i < raw.length) {
    if (/\s/.test(raw[i])) {
      const runStart = i;
      while (i < raw.length && /\s/.test(raw[i])) i += 1;
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
 * Raw offset → the node holding it and the offset within. On a node boundary,
 * `closing` picks the end of the previous node for a range's end and the start
 * of the next for its start, so the range doesn't reach into a neighbouring
 * <a> or <em> to enclose nothing. Empty nodes are skipped likewise.
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
  // The very end: clamp to the last non-empty node.
  for (let i = texts.length - 1; i >= 0; i -= 1) {
    if (texts[i].length > 0) return { index: i, offset: texts[i].length };
  }
  return null;
}
