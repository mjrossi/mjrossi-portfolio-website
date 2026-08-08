// The format of a pulled review file: where it lives, what a note's meta line
// looks like, and how to read the ids back out of it.
//
// BOTH SIDES LIVE HERE ON PURPOSE. scripts/galley-pull.mjs writes the file and
// this module reads it back, and the two used to state the shape independently —
// a template literal on one side, a regex written from memory of it on the
// other. Anything appended after the id would then make the scan miss those
// notes, and `galley-close` would close a subset while reporting the remainder
// as "filed after that pull", naming a reviewer who filed nothing. Silently.
// So the emitter is exported and the scan is written against it.
//
// `just galley-close` closes exactly the notes listed in docs/galley/<slug>.md.
// That set — rather than "every note written against a revision I have since
// replaced" — is the whole design: drift is a property of the FILE, not of
// whether anyone has read the note, so the moment a second reviewer exists a
// drift-based close retires feedback nobody has looked at. See CLAUDE.md.
//
// Split out of scripts/notes-db.mjs so `node --test` can reach it, on the same
// argument as galley-relocate.js: this is the function that decides what a close
// TOUCHES, and a regression in it is silent in both directions — it closes the
// wrong set, or nothing, and reports success either way. Nothing here does I/O;
// the caller reads the file.
//
// Plain JS for the same reason as csp.js, schedule.js, and preview.js.

/**
 * The shape of a note id: `crypto.randomUUID()`, which is what
 * src/pages/api/galley.ts writes.
 *
 * Shared with scripts/notes-db.mjs, which re-exports it — the scan below and the
 * SQL shape-check have to agree, and a looser pattern in either would matter.
 */
export const NOTE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Where `just galley` writes a pulled round, and where `just galley-close`
 * reads it back from. One definition, because that path is the entire handshake
 * between the two commands: move it in the writer alone and the close does not
 * fail on the wrong file, it fails on a MISSING one — "pull the round first",
 * pointing the operator at the command they just successfully ran.
 *
 * @param {string} slug
 * @returns {string} a repo-relative path
 */
export function galleyFile(slug) {
  return `docs/galley/${slug}.md`;
}

/**
 * The meta line above every note in a pulled file, and the only line
 * noteIdsInMarkdown reads an id from:
 *
 *   **jd** · comment · 2026-05-10 · `1f0c…`
 *   **jd** · suggestion · 2026-05-10 · now line 88 · `1f0c…`
 *   **jd** · comment · 2026-04-02 · closed 2026-04-09 · `1f0c…`
 *
 * THE ID GOES LAST, and the scan below is anchored to that. `detail` is the one
 * place a caller may add anything — a relocation for an open note, a closure
 * date for a closed one — so a new field cannot be appended past the id where
 * the scan would stop seeing it.
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

// Anchored at BOTH ends — starts with the bold reviewer label, ends with the
// backticked id — because the alternative is what this replaced: scanning the
// whole document for a backticked UUID.
//
// THAT MATTERED. Reviewer prose is emitted into this file too (blockquoted by
// pushQuoted, fenced by pushFenced), and a reviewer can read note ids straight
// off GET /api/galley. So a note whose body quoted a colleague's id closed that
// colleague's note — no hostile intent required, and nothing anywhere would say
// it had happened. Editors are invited collaborators, so this was never an
// attack surface; it was a way for the file to stop meaning what the close
// command claims it means.
const META_LINE_RE = /^\*\*[^*]+\*\*.*·\s*`([0-9a-f-]{36})`$/;

// A fence opened by pushFenced. Its content is reviewer-authored and arbitrary,
// including lines shaped exactly like the meta line above — and, crucially,
// including SHORTER fences of its own. Captured rather than merely detected; see
// the close rule in noteIdsInMarkdown.
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

/**
 * The heading `just galley <slug> --all` writes above the closed-round
 * appendix, and the line the scan below stops at. Exported so galley-pull.mjs
 * emits this exact string rather than a second copy of it: rename it in the
 * writer alone and the cut stops firing, closed ids re-enter the manifest, and
 * the close reports "lists 14 note(s) … 6 closed" with nothing saying why.
 */
export const CLOSED_HEADING = '## Closed notes';

/**
 * Every note id a pulled review file lists, in order, deduplicated.
 *
 * An id this misses simply stays open, which is the direction that loses
 * nothing: the operator sees "lists 6, closed 5" and can name the sixth.
 *
 * @param {string} text the contents of docs/galley/<slug>.md
 * @returns {string[]}
 */
export function noteIdsInMarkdown(text) {
  const ids = [];
  // The OPENING fence, held verbatim while inside a block — not a boolean.
  //
  // A toggle was wrong in both directions, and not only in theory. pushFenced
  // picks a fence longer than the longest backtick run in its content
  // (galley-relocate.js `fenceFor`), precisely so a suggestion containing ```
  // cannot end the block early — but a toggle flips on that inner ``` anyway,
  // and `fenceFor` never measures tildes at all, so a lone ~~~ flips it too. An
  // ODD number of fence-shaped lines inside one suggestion then inverts the scan
  // for the rest of the file, which costs an EXTRA id and not just a missed one:
  // a meta-shaped line inside that reviewer's prose becomes closable, which is
  // exactly the "one note closes another reviewer's" bug this scan exists to
  // prevent, while the real ids after it are swallowed and reported as notes
  // someone filed after the pull.
  //
  // So: close only on the same fence character, at least as long as the opener.
  // That is CommonMark's own rule, and it is the rule `fenceFor` already writes
  // to — which is what makes the reader and the writer agree by construction.
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
    // Stop at the closed-notes appendix `--all` writes. Those ids are already
    // closed, so scanning them would be harmless — closeNotes matches only rows
    // with closed_at IS NULL — but it would report "lists 14 notes, closed 6"
    // and leave the operator wondering what happened to the other eight.
    //
    // Compared per line, and inside the loop so it is reached only OUTSIDE a
    // fence: a suggestion whose replacement text renames a section to the
    // heading cut the manifest short when this was a split over the raw
    // document.
    if (line === CLOSED_HEADING) break;
    const meta = META_LINE_RE.exec(line.trimEnd());
    if (!meta) continue;
    // Belt and braces: META_LINE_RE's 36-character class admits hyphens
    // anywhere, so the full shape is still checked before the id is used.
    if (NOTE_ID_RE.test(meta[1]) && !ids.includes(meta[1])) ids.push(meta[1]);
  }
  return ids;
}
