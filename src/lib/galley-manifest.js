// Reading a pulled review file back as a manifest of note ids.
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

// The meta line scripts/galley-pull.mjs writes above every note:
//
//   **jd** · comment · 2026-05-10 · `1f0c…`
//   **jd** · suggestion · 2026-05-10 · now line 88 · `1f0c…`
//
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
// including lines shaped exactly like the meta line above.
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

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
  // Stop at the closed-notes appendix `--all` writes. Those ids are already
  // closed, so scanning them would be harmless — closeNotes matches only rows
  // with closed_at IS NULL — but it would report "lists 14 notes, closed 6" and
  // leave the operator wondering what happened to the other eight.
  const body = String(text).split(/^## Closed notes$/m)[0];

  const ids = [];
  let inFence = false;
  for (const line of body.split('\n')) {
    // Toggle rather than match the opening fence's own length: pushFenced picks
    // a fence longer than the longest run inside, so the closer is whatever
    // reopens this state. Getting it wrong costs a missed id, never an extra.
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const found = META_LINE_RE.exec(line.trimEnd());
    if (!found) continue;
    // Belt and braces: META_LINE_RE's 36-character class admits hyphens
    // anywhere, so the full shape is still checked before the id is used.
    if (NOTE_ID_RE.test(found[1]) && !ids.includes(found[1])) ids.push(found[1]);
  }
  return ids;
}
