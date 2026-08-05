// Finding a galley note's passage in the .mdx as it stands now, and emitting
// reviewer-authored text into markdown without letting it restructure the
// document. See CLAUDE.md, "The galley".
//
// Split out of scripts/galley-pull.mjs so `node --test` can reach it. That
// script parses argv and shells out to wrangler at import time, so every one of
// these functions was unreachable from a test — which is the wrong way round,
// because this is the least obvious code in the feature. The two invariants
// that matter (an ambiguous quote resolves to NOTHING; typography is folded on
// both sides before searching) are asserted in galley-relocate.test.js.
//
// Plain JS for the same reason as csp.js, schedule.js, and preview.js.

/**
 * Strip inline markdown down to the text a browser would render.
 *
 * Applied to the SOURCE side only, and this direction matters. A note's quote
 * comes from `block.textContent`, which has no markup in it at all, while the
 * search runs against raw .mdx — so any selection spanning a link, emphasis, or
 * a code span is not a substring of the line that contains it:
 *
 *   source: `we shipped [the Atlas](https://…) last spring`
 *   quote:  `we shipped the Atlas last spring`
 *
 * Every post in this repo carries inline links, and editors select whole
 * sentences, so without this the second half of the two-part anchor is dead
 * exactly when the line range has gone stale and it is the only half left.
 *
 * One-directional on purpose: folding the quote side too would mean guessing at
 * markup the client already discarded, and a wrong guess produces a confident
 * match on the wrong passage. Here the worst case is a line that fails to
 * match, which is the behaviour that was already being reported safely.
 */
export function unmark(text) {
  // Escaped punctuation is literal text, not markup, so it has to come out of
  // the way BEFORE the stripping passes below rather than after. Unescaping
  // last looks tidier and is wrong: the emphasis rule reaches `\*` first, eats
  // the asterisk, and leaves a bare backslash in prose that never had one.
  // Parked as a NUL-delimited index, which cannot occur in .mdx source.
  const literals = [];
  const parked = String(text).replace(/\\([\\`*_{}[\]()#+\-.!])/g, (_, ch) => {
    literals.push(ch);
    return `\u0000${literals.length - 1}\u0000`;
  });

  const stripped = parked
    // Images contribute nothing to textContent — alt text is an attribute.
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    // Inline and reference links render as their label.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    // Emphasis and strong.
    .replace(/\*{1,3}/g, '')
    // Underscore emphasis, at word boundaries only: snake_case identifiers and
    // file names appear in this blog's prose and must survive intact.
    .replace(/(^|[\s([{])_{1,3}(?=\S)/g, '$1')
    .replace(/(\S)_{1,3}(?=$|[\s.,;:!?)\]}])/g, '$1')
    // Inline code spans.
    .replace(/`+/g, '');

  return stripped.replace(/\u0000(\d+)\u0000/g, (_, i) => literals[Number(i)]);
}

/**
 * Normalise typography so a browser selection can match .mdx source.
 *
 * Astro's smartypants turns ' into ’ and -- into an em dash, so an editor's
 * selection never matches the source byte-for-byte. Folding both sides is what
 * makes "find the passage this note is about" work at all — without it every
 * single note would look like it had drifted.
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
 * Build a `locate` bound to one file's lines.
 *
 * A factory rather than a free function because the folded form of every line
 * is computed once per pull and reused across every note.
 *
 * @param {string[]} sourceLines the .mdx split on newlines
 */
export function createLocator(sourceLines) {
  const foldedLines = sourceLines.map((line) => fold(unmark(line)));

  /**
   * Where does this quote live in the file as it stands now?
   *
   * Returns a 1-based line number, or null. This is what makes a note
   * applicable after the post has been revised: the stored line number may be
   * stale, but the quote usually still identifies the passage. Paragraphs in
   * this repo are single long lines, so a per-line search finds nearly
   * everything; a quote that spans a source line break falls through to null
   * and is reported as needing a human eye rather than guessed at.
   *
   * `prefix` / `suffix` are the ~32 characters either side of the selection,
   * recorded by public/scripts/galley.js. They are the second half of the
   * two-part anchor and exist for exactly one case: the quote is findable but
   * appears more than once. A bare quote search has to give up there — naming
   * one of three identical sentences is how a note gets applied in the wrong
   * section — whereas the surrounding context usually separates them. Retrying
   * with the context is therefore the whole point of storing it.
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

    // Ambiguous. Re-search with the context either side folded in. Both sides
    // are folded together rather than separately because the context was
    // captured from rendered text with collapsed whitespace, so the boundary
    // between prefix and quote may not survive as a separate token.
    if (hits.length > 1 && (prefix || suffix)) {
      const wide = fold(`${prefix}${quote}${suffix}`);
      const narrowed = hits.filter((line) => foldedLines[line - 1].includes(wide));
      if (narrowed.length === 1) return narrowed[0];
    }

    // Still ambiguous, or absent. Reported as needing a human eye — see the
    // "search for" hint the caller emits — rather than guessed at.
    return null;
  };
}

// ── emitting reviewer text safely ────────────────────

// Everything below is written by a reviewer, and the file it lands in is read
// by a person AND handed to Claude alongside the .mdx. Raw interpolation makes
// note text structural: a body containing ``` closes the enclosing fence, and
// one containing `## Line 12` forges a section heading in a document whose
// headings are how notes are attributed to passages. Editors are invited by
// link so this is not a hostile-input surface, but the failure is silent and
// the fix is cheap.

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
