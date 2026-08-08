// Turning a post's notes into the pulled review file. See CLAUDE.md, "The galley".
//
// Split out of scripts/galley-pull.mjs on exactly the argument that already moved
// galley-relocate.js and galley-manifest.js out of it: that script parses argv and
// shells out to wrangler at import time, so none of this was reachable from
// `node --test`, and this is the half of the pull with decisions in it. The I/O
// stays there — read the .mdx, query D1, write the file — and everything that
// decides what the document SAYS is here.
//
// What that buys, concretely. Two of the rules below are the kind that fail
// quietly rather than loudly:
//
//   - a group whose notes relocate to DIFFERENT lines must not claim one of them
//     on its heading (see resolveGroup). Get it wrong and the file reads
//     "## Line 42-47 — now line 88" over a note that was never about line 88.
//   - a note's stored anchor wins over a relocation when the file has NOT
//     drifted. Get it wrong and the excerpt under a heading comes from somewhere
//     else entirely.
//
// Neither shows up as an error. Both are pinned in galley-render.test.js.
//
// Plain JS for the same reason as galley-relocate.js, galley-manifest.js,
// schedule.js and preview.js: no astro: imports, so `node --test` can load it.

import { CLOSED_HEADING, noteMetaLine } from './galley-manifest.js';
import { createLocator, pushFenced, pushQuoted } from './galley-relocate.js';

/** How far past an anchor to look for a line with content on it. */
const EXCERPT_SCAN = 4;

/** Longest excerpt printed under a heading before it is elided. */
const EXCERPT_MAX = 300;

/**
 * A timestamp as the day it fell on, which is the only precision this file ever
 * shows. One definition because the meta line has three date fields between its
 * open and closed forms, and three spellings of the same slice is how one of
 * them ends up a character wider than the others.
 *
 * @param {number | Date} value epoch ms, or a Date
 * @returns {string} YYYY-MM-DD
 */
export function isoDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * The quote with its stored context, for a human to search by hand.
 *
 * Emitted only where `locate` could not resolve the passage — it is the fallback
 * the prefix/suffix pair was recorded for. Returns null when there is nothing
 * worth printing, so the caller can skip the section rather than print an empty
 * one.
 *
 * @param {Record<string, unknown>} note
 * @returns {string | null}
 */
export function contextHint(note) {
  const ctx = `${note.prefix ?? ''}${note.quote ?? ''}${note.suffix ?? ''}`.trim();
  return ctx || null;
}

/**
 * The source line to show under a heading, skipping a code fence.
 *
 * `code` nodes are anchored across their whole span, fences included, so a note
 * on a code block resolves to the ``` line rather than to any code. Advance to
 * the first line with content on it so the excerpt shows what the note is
 * actually about. Bounded to a few lines: past that the anchor is pointing
 * somewhere unexpected, and printing nothing beats printing something
 * misleading.
 *
 * @param {string[]} sourceLines
 * @param {number} index 0-based
 * @returns {string | null}
 */
export function excerptAt(sourceLines, index) {
  for (let i = index; i < Math.min(index + EXCERPT_SCAN, sourceLines.length); i++) {
    const text = sourceLines[i]?.trim();
    if (!text) continue;
    if (/^(`{3,}|~{3,})/.test(text)) continue;
    return text;
  }
  return null;
}

/**
 * Group notes by the passage they are anchored to, in the order they should be
 * read: by source line, with unanchored whole-draft notes last.
 *
 * The key doubles as the heading's line range, and `'general'` is the sentinel
 * for "no anchor" — which every caller below discriminates on, so it must stay
 * a value no line range can produce.
 *
 * @param {Record<string, unknown>[]} rows
 * @returns {[string, Record<string, unknown>[]][]}
 */
export function groupByAnchor(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.src_start ? `${row.src_start}-${row.src_end}` : 'general';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.entries()].sort((a, b) => {
    if (a[0] === 'general') return 1;
    if (b[0] === 'general') return -1;
    return Number(a[0].split('-')[0]) - Number(b[0].split('-')[0]);
  });
}

/**
 * Where one anchored group's notes live in the file as it stands now.
 *
 * RESOLVES EVERY QUOTED NOTE, not just the first. Notes share an anchor whenever
 * they were filed against the same block, but they can quote different sentences
 * within it — so a single "now line N" taken from whichever note happened to sort
 * first was being presented as the heading for all of them.
 *
 * The group therefore only claims a relocation when it AGREES: every quoted note
 * found, and all at the same line. Otherwise `line` is null and each note carries
 * its own below, which is what `lineOf` is for. Same stance as `locate` itself
 * resolving an ambiguous quote to nothing — refuse rather than state something
 * that will be confidently wrong.
 *
 * `lineOf` is a Map rather than a field written onto each row: these rows come
 * straight from D1 and are the caller's, and a render pass should not leave marks
 * on them.
 *
 * @param {Record<string, unknown>[]} notes one group
 * @param {(quote: string, prefix?: string, suffix?: string) => number | null} locate
 * @returns {{ line: number | null, anyFound: boolean, lineOf: Map<object, number | null> }}
 */
export function resolveGroup(notes, locate) {
  const lineOf = new Map();
  for (const note of notes) lineOf.set(note, locate(note.quote, note.prefix, note.suffix));

  const resolved = notes.filter((n) => n.quote).map((n) => lineOf.get(n));
  const agreed = new Set(resolved.filter((line) => line !== null));
  const line =
    resolved.length > 0 && resolved.every(Boolean) && agreed.size === 1 ? [...agreed][0] : null;

  return { line, anyFound: resolved.some(Boolean), lineOf };
}

/**
 * A note's own content: what the reviewer quoted, wrote, and proposed.
 *
 * Shared by the open-note loop and the closed appendix, which emit exactly this
 * and differ only in their heading and meta line. EVERY reviewer-authored string
 * goes through pushQuoted or pushFenced — prefix/suffix are stored verbatim and
 * newlines survive them, so interpolating any of it raw would let a note forge a
 * `##` heading in a document whose headings are how notes get attributed to
 * passages. Keeping that rule in one function is the point of the function.
 *
 * @param {string[]} lines
 * @param {Record<string, unknown>} note
 * @param {string | null} hint context to print under the quote, already built
 */
export function pushNoteContent(lines, note, hint = null) {
  if (note.quote) {
    pushQuoted(lines, note.quote);
    lines.push('');
    if (hint) {
      lines.push('Context when written:');
      lines.push('');
      pushQuoted(lines, `…${hint}…`);
      lines.push('');
    }
  }
  if (note.body) {
    pushQuoted(lines, note.body);
    lines.push('');
  }
  if (note.suggestion) {
    lines.push('Suggested replacement:');
    lines.push('');
    pushFenced(lines, note.suggestion, 'md');
    lines.push('');
  }
}

/**
 * The whole pulled review file.
 *
 * THIS FILE IS A MANIFEST as well as a document: every note is printed with its
 * id via noteMetaLine, and `just galley-close` closes exactly the ids it finds
 * here. The emitter and the scan that reads it back both live in
 * galley-manifest.js so the writer cannot drift from the reader.
 *
 * `pulledAt` is a parameter rather than a `new Date()` inside, so the output is a
 * function of its inputs and a test can assert on the whole document.
 *
 * @param {object} args
 * @param {string} args.slug
 * @param {string} args.sourcePath repo-relative, for the Source: line
 * @param {string[]} args.sourceLines the .mdx split on newlines
 * @param {string} args.currentHash revision hash of the .mdx as it stands
 * @param {Record<string, unknown>[]} args.rows open notes, oldest first
 * @param {Record<string, unknown>[]} args.closedRows closed notes (empty unless --all)
 * @param {string} args.database the label to name in the header
 * @param {Date} [args.pulledAt]
 * @returns {{ markdown: string, open: number, closed: number, drifted: number }}
 */
export function renderReviewFile({
  slug,
  sourcePath,
  sourceLines,
  currentHash,
  rows,
  closedRows,
  database,
  pulledAt = new Date(),
}) {
  const locate = createLocator(sourceLines);

  // Counted over OPEN notes only. A closed note is drifted almost by definition --
  // the revision that closed it is the one that changed the file -- so counting
  // those would put a drift warning on every pull forever and train the reader to
  // ignore the one that matters.
  const drifted = rows.filter((r) => r.revision_hash !== currentHash).length;

  const lines = [];
  lines.push(`# Review notes — ${slug}`);
  lines.push('');
  lines.push(`Pulled ${pulledAt.toISOString()} from \`${database}\`.`);
  const reviewers = new Set(rows.map((r) => r.reviewer)).size;
  const openLabel = `${rows.length} open note${rows.length === 1 ? '' : 's'}`;
  lines.push(
    closedRows.length > 0
      ? `${openLabel}, ${reviewers} reviewer(s) — plus ${closedRows.length} closed, below.`
      : `${openLabel}, ${reviewers} reviewer(s).`,
  );
  lines.push('');
  // The manifest contract, stated in the artifact itself: `just galley-close`
  // closes the ids printed below and nothing else, so a reader who edits this file
  // by hand needs to know that deleting a note here spares it.
  lines.push(
    '> Each note carries its id. `just galley-close ' +
      slug +
      '` closes exactly the ids in this file — notes filed after this pull are left open.',
  );
  lines.push('');
  if (drifted > 0) {
    lines.push(
      `> **${drifted} of these were written against an earlier revision.** Their stored line ` +
        'numbers are stale. Where the quoted text was still findable, the current line is ' +
        'given as "now line N" — otherwise search for the quote by hand.',
    );
    lines.push('');
  }
  lines.push(`Source: \`${sourcePath}\``);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const [key, notes] of groupByAnchor(rows)) {
    // Declared out here because the per-note loop below needs it: when the group
    // could NOT agree on a single relocation, each note carries its own.
    let current = null;
    let lineOf = new Map();
    if (key === 'general') {
      lines.push('## Whole-draft notes');
    } else {
      const stale = notes.some((n) => n.revision_hash !== currentHash);
      const group = resolveGroup(notes, locate);
      current = group.line;
      lineOf = group.lineOf;

      let heading = `## Line ${key}`;
      if (stale) {
        if (current) {
          heading += ` — now line ${current}`;
        } else if (group.anyFound) {
          // Found, but not all in the same place — these notes share an anchor
          // while quoting different sentences. Saying "not found" here would be
          // wrong, and saying "now line N" would pick one of them arbitrarily.
          heading += ' — ⚠ revision drift, notes relocated individually below';
        } else {
          heading += ' — ⚠ revision drift, quote not found';
        }
      }
      lines.push(heading);
      if (!stale || current) {
        // When the file has NOT drifted the stored anchor is authoritative by
        // definition, so it wins over a relocation. Preferring `current`
        // unconditionally could put a heading reading "## Line 42-47" above an
        // excerpt taken from somewhere else entirely — the quote resolving
        // elsewhere in an unchanged file means the anchor is the trustworthy half.
        const at = (stale ? current : Number(key.split('-')[0])) - 1;
        const text = excerptAt(sourceLines, at);
        if (text) {
          lines.push('');
          pushFenced(lines, text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}…` : text, 'md');
        }
      }
    }
    lines.push('');

    for (const note of notes) {
      const noteLine = lineOf.get(note);
      lines.push(
        noteMetaLine({
          reviewer: note.reviewer,
          kind: note.kind,
          when: isoDay(note.created_at),
          // Per-note relocation, for the case the heading could not claim one:
          // the notes in this group resolve to different lines, so each says
          // where its own passage went.
          detail: key !== 'general' && !current && noteLine ? `now line ${noteLine}` : null,
          id: note.id,
        }),
      );
      lines.push('');
      // Nothing else in this file can point at the passage, so hand over the
      // context the note was written against. This is the case prefix/suffix were
      // recorded for and that locate() could not resolve on its own.
      const hint = key !== 'general' && !noteLine ? contextHint(note) : null;
      pushNoteContent(lines, note, hint);
    }
    lines.push('---');
    lines.push('');
  }

  // ── closed rounds (--all only) ───────────────────────
  //
  // Flat and unanchored on purpose. These notes were written against revisions the
  // file no longer holds, so relocating them would be guesswork on a passage that
  // has already been dealt with; what is wanted here is the record of what was
  // said and when it was retired, not a pointer into the current draft.
  if (closedRows.length > 0) {
    // The exact string noteIdsInMarkdown stops at, imported rather than retyped:
    // a rename here alone would let closed ids back into the manifest.
    lines.push(CLOSED_HEADING);
    lines.push('');
    lines.push(
      `${closedRows.length} note(s) from round(s) already applied or declined. ` +
        `Re-open one with \`just galley-reopen ${slug} --note <id>\`.`,
    );
    lines.push('');
    for (const note of closedRows) {
      lines.push(
        noteMetaLine({
          reviewer: note.reviewer,
          kind: note.kind,
          when: isoDay(note.created_at),
          detail: `closed ${isoDay(note.closed_at)}`,
          id: note.id,
        }),
      );
      lines.push('');
      // No context hint: these notes are not being relocated, so there is nothing
      // to point the author at.
      pushNoteContent(lines, note);
    }
    lines.push('---');
    lines.push('');
  }

  return {
    markdown: `${lines.join('\n').trimEnd()}\n`,
    open: rows.length,
    closed: closedRows.length,
    drifted,
  };
}
