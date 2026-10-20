// Finding a note's passage in the .mdx as it stands now, and emitting
// reviewer-written text into markdown without letting it restructure the file.
// Out of scripts/galley-pull.mjs so `node --test` can reach it. The two
// invariants: an ambiguous quote resolves to NOTHING, and typography is folded
// on both sides before searching.

/**
 * Strip inline markdown to the text a browser renders.
 *
 * SOURCE side only. A quote comes from `textContent`, with no markup, so a
 * selection spanning a link or emphasis is not a substring of the raw line:
 *
 *   source: `we shipped [the Atlas](https://…) last spring`
 *   quote:  `we shipped the Atlas last spring`
 *
 * Folding the quote side too would mean guessing at discarded markup, and a
 * wrong guess is a confident match on the wrong passage.
 */
export function unmark(text) {
  // Escapes are parked BEFORE stripping: unescaping last lets the emphasis rule
  // eat `\*`'s asterisk and leave a stray backslash. NUL can't occur in .mdx.
  const literals = [];
  const parked = String(text).replace(/\\([\\`*_{}[\]()#+\-.!])/g, (_, ch) => {
    literals.push(ch);
    return `\u0000${literals.length - 1}\u0000`;
  });

  const stripped = parked
    // Images: alt text is an attribute, not textContent.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    .replace(/\*{1,3}/g, '')
    // Underscores at word boundaries only, so snake_case survives.
    .replace(/(^|[\s([{])_{1,3}(?=\S)/g, '$1')
    .replace(/(\S)_{1,3}(?=$|[\s.,;:!?)\]}])/g, '$1')
    .replace(/`+/g, '');

  return stripped.replace(/\u0000(\d+)\u0000/g, (_, i) => literals[Number(i)]);
}

/**
 * Normalise typography on both sides. Smartypants turns ' into ’ and -- into a
 * dash, so without this every note would look drifted.
 */
export function fold(text) {
  return String(text)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '--')
    .replace(/…/g, '...')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Build a `locate` for one file; each line is folded once per pull.
 *
 * @param {string[]} sourceLines the .mdx split on newlines
 */
export function createLocator(sourceLines) {
  const foldedLines = sourceLines.map((line) => fold(unmark(line)));

  /**
   * The 1-based line this quote is on now, or null. A quote spanning a source
   * line break returns null and is flagged for a human, never guessed.
   *
   * `prefix` / `suffix` (~32 characters either side, from galley.js) exist for
   * one case: the quote appears more than once. Naming one of three identical
   * sentences is how a note lands in the wrong section.
   */
  return function locate(quote, prefix = '', suffix = '') {
    if (!quote) return null;
    const needle = fold(quote);
    if (!needle) return null;
    const hits = [];
    for (let i = 0; i < foldedLines.length; i++) {
      if (foldedLines[i].includes(needle)) hits.push(i + 1);
    }
    if (hits.length === 1) return hits[0];

    // Ambiguous: retry with the context. Folded as one string, because the
    // prefix/quote boundary may not survive collapsed whitespace.
    if (hits.length > 1 && (prefix || suffix)) {
      const wide = fold(`${prefix}${quote}${suffix}`);
      const narrowed = hits.filter((line) => foldedLines[line - 1].includes(wide));
      if (narrowed.length === 1) return narrowed[0];
    }

    // Still ambiguous, or absent: the caller flags it for a human.
    return null;
  };
}

// ── emitting reviewer text safely ────────────────────

// Everything below emits reviewer-written text into a file read by a person
// and by Claude. Raw, a ``` would close the enclosing fence and `## Line 12`
// would forge a heading. Not a hostile-input surface, but silent and cheap to fix.

/**
 * A fence guaranteed longer than the longest backtick run in `text`, so content
 * containing a fence of its own cannot terminate the block early.
 */
export function fenceFor(text) {
  let longest = 0;
  for (const run of String(text).matchAll(/`+/g)) longest = Math.max(longest, run[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Push `text` as a fenced block that its own content cannot break out of. */
export function pushFenced(lines, text, info = '') {
  const fence = fenceFor(text);
  lines.push(`${fence}${info}`);
  lines.push(text);
  lines.push(fence);
}

/**
 * Push reviewer prose as a blockquote. Keeps it readable as prose while making
 * it structurally clear whose words they are — and a `#` or fence inside is
 * contained by the quote rather than restructuring the document around it.
 */
export function pushQuoted(lines, text) {
  for (const line of String(text).split('\n')) lines.push(line ? `> ${line}` : '>');
}
