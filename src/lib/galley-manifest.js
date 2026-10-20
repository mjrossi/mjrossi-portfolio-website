// The format of a pulled review file: its path, a note's meta line, and how to
// read the ids back out. Writer and reader live together so they cannot drift
// — a field appended after the id once made `galley-close` close a subset.
//
// `just galley-close` closes exactly the notes the file lists, not "everything
// against an old revision": drift is a property of the file, not of whether
// anyone read the note. Plain JS and I/O-free, so `node --test` reaches it.

/** `crypto.randomUUID()`, as /api/galley writes. Shared with notes-store.js. */
export const NOTE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Where `just galley` writes a round and `just galley-close` reads it back: the
 * whole handshake between the two commands.
 *
 * @param {string} slug
 * @returns {string} a repo-relative path
 */
export function galleyFile(slug) {
  return `docs/galley/${slug}.md`;
}

/**
 * The meta line above every note, and the only line an id is read from:
 *
 *   **jd** · comment · 2026-05-10 · `1f0c…`
 *   **jd** · suggestion · 2026-05-10 · now line 88 · `1f0c…`
 *
 * THE ID GOES LAST; the scan is anchored to it. New fields go in `detail`.
 *
 * @param {{ reviewer: string, kind: string, when: string,
 *           detail?: string | null, id: string }} note
 * @returns {string}
 */
export function noteMetaLine({ reviewer, kind, when, detail = null, id }) {
  const parts = [`**${reviewer}**`, kind, when];
  if (detail) parts.push(detail);
  parts.push(`\`${id}\``);
  return parts.join(' · ');
}

// Anchored at both ends, not "any backticked UUID": reviewer prose is in this
// file too, and a note quoting a colleague's id used to close that note.
const META_LINE_RE = /^\*\*[^*]+\*\*.*·\s*`([0-9a-f-]{36})`$/;

// A fence opened by pushFenced. Its reviewer-written content can include
// meta-shaped lines and shorter fences of its own.
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/** Where the closed-round appendix starts, and the scan stops. Shared with the writer. */
export const CLOSED_HEADING = '## Closed notes';

/**
 * Every note id a pulled file lists, in order, deduplicated. A missed id stays
 * open, the direction that loses nothing.
 *
 * @param {string} text the contents of docs/galley/<slug>.md
 * @returns {string[]}
 */
export function noteIdsInMarkdown(text) {
  const ids = [];
  // The OPENING fence, held verbatim — not a boolean. A toggle flipped on an
  // inner ``` or a lone ~~~, and an odd number of those inverted the scan for
  // the rest of the file, making a meta-shaped line in reviewer prose closable.
  // Close only on the same character, at least as long: CommonMark's rule, and
  // the one fenceFor writes to.
  let fence = null;
  for (const line of String(text).split('\n')) {
    const found = FENCE_RE.exec(line);
    if (fence !== null) {
      if (found && found[1][0] === fence[0] && found[1].length >= fence.length) fence = null;
      continue;
    }
    if (found) {
      fence = found[1];
      continue;
    }
    // Checked per line and only outside a fence, so a suggestion containing the
    // heading cannot cut the manifest short.
    if (line === CLOSED_HEADING) break;
    const meta = META_LINE_RE.exec(line.trimEnd());
    if (!meta) continue;
    // The regex's 36-character class admits hyphens anywhere; check the full shape.
    if (NOTE_ID_RE.test(meta[1]) && !ids.includes(meta[1])) ids.push(meta[1]);
  }
  return ids;
}
