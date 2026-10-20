// Turning a post's notes into the pulled review file, and the model the Desk
// renders. scripts/galley-pull.mjs keeps the I/O; everything that decides what
// the document SAYS is here, where `node --test` can reach it.
//
// Two rules fail silently, and galley-render.test.js pins both:
//   - a group whose notes relocate to DIFFERENT lines must not claim one of
//     them on its heading (resolveGroup);
//   - when the file has NOT drifted, the stored anchor beats a relocation.

import { CLOSED_HEADING, noteMetaLine } from './galley-manifest.js';
import { createLocator, pushFenced, pushQuoted } from './galley-relocate.js';

/** How far past an anchor to look for a line with content on it. */
const EXCERPT_SCAN = 4;

/** Longest excerpt printed under a heading before it is elided. */
const EXCERPT_MAX = 300;

/** Longest section label printed, on a heading or in the summary. */
const SECTION_MAX = 56;

/** The label for notes anchored above the post's first heading. */
const NO_SECTION = '(before the first heading)';

/** Stale and unfindable. Distinct from NO_SECTION, which is a positive claim. */
const UNKNOWN_SECTION = '(section unknown)';

/** The summary row for unanchored notes, matching the `## Whole-draft notes` heading. */
const WHOLE_DRAFT = 'Whole-draft';

/**
 * Marks a second note by the same reviewer on the same passage. Deliberately
 * neutral: it might be a retraction or an afterthought, and only the adjacency
 * is certain.
 */
const SAME_PASSAGE = '↳ same passage as above';

// A fence in the .mdx. Same CommonMark rule as galley-manifest.js, which scans
// a different document; kept separate on purpose.
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

// ATX headings only. A setext heading yields no label, never a wrong one.
const ATX_RE = /^ {0,3}(#{1,6})\s+(.*)$/;

/**
 * A timestamp as YYYY-MM-DD, the only precision this file shows.
 *
 * @param {number | Date} value epoch ms, or a Date
 * @returns {string}
 */
export function isoDay(value) {
  return new Date(value).toISOString().slice(0, 10);
}

/**
 * The quote with its context, for searching by hand where `locate` failed.
 * Null when there is nothing to print.
 *
 * @param {Record<string, unknown>} note
 * @returns {string | null}
 */
export function contextHint(note) {
  const ctx = `${note.prefix ?? ''}${note.quote ?? ''}${note.suffix ?? ''}`.trim();
  return ctx || null;
}

/**
 * The source line to show under a heading. A note on a code block is anchored
 * at its ``` line, so skip to the first content line — but only a few lines,
 * since printing nothing beats printing something misleading.
 *
 * @param {string[]} sourceLines
 * @param {number} index 0-based
 * @returns {string | null}
 */
export function excerptAt(sourceLines, index) {
  for (let i = index; i < Math.min(index + EXCERPT_SCAN, sourceLines.length); i++) {
    const text = sourceLines[i]?.trim();
    if (!text) continue;
    if (FENCE_RE.test(text)) continue;
    return text;
  }
  return null;
}

/**
 * Every line of the .mdx mapped to the heading it sits under.
 *
 * One forward pass, because fence state decides what is a heading: a `## `
 * inside a code block is not one. The nearest heading of any level wins. The
 * value carries the heading's LINE as well as its text, because a post can
 * repeat the same words under two parts.
 *
 * @param {string[]} sourceLines
 * @returns {Map<number, { line: number, text: string } | null>} 0-based index → heading
 */
export function sectionMap(sourceLines) {
  const map = new Map();

  // Skip the leading frontmatter, where `# foo` is a YAML comment. A later `---`
  // is a thematic break.
  let start = 0;
  if (sourceLines[0]?.trim() === '---') {
    const end = sourceLines.findIndex((line, i) => i > 0 && line.trim() === '---');
    if (end > 0) {
      for (let i = 0; i <= end; i++) map.set(i, null);
      start = end + 1;
    }
  }

  let fence = null;
  let current = null;
  for (let i = start; i < sourceLines.length; i++) {
    const line = sourceLines[i];
    const found = FENCE_RE.exec(line);
    if (fence !== null) {
      // Same character, at least as long (CommonMark); a toggle flips on a
      // shorter inner fence.
      if (found && found[1][0] === fence[0] && found[1].length >= fence.length) fence = null;
    } else if (found) {
      fence = found[1];
    } else {
      const heading = ATX_RE.exec(line);
      if (heading) {
        const text = heading[2].trim().replace(/\s+#+$/, '');
        current = text ? { line: i, text } : null;
      }
    }
    map.set(i, current);
  }
  return map;
}

/**
 * Group byte-identical notes (a double-submit) so their content prints once.
 *
 * Safe only because the manifest is line-based: the caller still prints one
 * meta line per id, so every id stays closable. The key includes prefix and
 * suffix — the same words at a different occurrence are a different note.
 *
 * @param {Record<string, unknown>[]} notes
 * @returns {{ ids: string[], notes: Record<string, unknown>[] }[]}
 */
export function collapseDuplicates(notes) {
  const byContent = new Map();
  for (const note of notes) {
    const key = JSON.stringify([
      note.reviewer,
      note.kind,
      note.quote,
      note.prefix,
      note.suffix,
      note.body,
      note.suggestion,
    ]);
    const entry = byContent.get(key);
    if (entry) {
      entry.ids.push(note.id);
      entry.notes.push(note);
    } else {
      byContent.set(key, { ids: [note.id], notes: [note] });
    }
  }
  return [...byContent.values()];
}

/**
 * @param {string | null} text
 * @returns {string | null}
 */
function sectionLabel(text) {
  if (!text) return null;
  return text.length > SECTION_MAX ? `${text.slice(0, SECTION_MAX - 1)}…` : text;
}

/**
 * Group notes by anchor, by source line, whole-draft notes last. The key is the
 * line range; `'general'` means no anchor and must stay unproducible as a range.
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
 * Where one group's notes live now.
 *
 * Resolves EVERY quoted note: notes on one block can quote different sentences.
 * The group claims a line only when all of them are found at the SAME line;
 * otherwise `line` is null and each note reports its own via `lineOf`. A Map,
 * not a field on the row, so the caller's D1 rows are left untouched.
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
 * A note's content: what the reviewer quoted, wrote and proposed. EVERY
 * reviewer-written string goes through pushQuoted or pushFenced, or a note
 * could forge a `##` heading; keeping that in one function is its purpose.
 *
 * @param {string[]} lines
 * @param {Record<string, unknown>} note
 * @param {string | null} hint context to print under the quote
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
 * What a review round SAYS, as data: one model, two presentations (the markdown
 * `just galley` writes and the Desk's HTML). Everything in it fails silently
 * when wrong, so it exists once, under test.
 *
 * @param {object} args
 * @param {string[]} args.sourceLines the .mdx split on newlines
 * @param {string} args.currentHash revision hash of the .mdx as it stands
 * @param {Record<string, unknown>[]} args.rows open notes, oldest first
 * @param {Record<string, unknown>[]} [args.closedRows] closed notes
 */
export function reviewModel({ sourceLines, currentHash, rows, closedRows = [] }) {
  const locate = createLocator(sourceLines);

  // Open notes only: a closed note is drifted almost by definition.
  const drifted = rows.filter((r) => r.revision_hash !== currentHash).length;

  // Resolved once per group, so the label and the excerpt come from the SAME
  // index and a heading can't name a different passage from its excerpt.
  const sections = sectionMap(sourceLines);
  const groups = groupByAnchor(rows).map(([key, notes]) => {
    const entries = collapseDuplicates(notes);
    if (key === 'general') {
      return {
        key,
        notes,
        entries,
        label: WHOLE_DRAFT,
        sectionKey: WHOLE_DRAFT,
        section: null,
        stale: false,
        current: null,
        anchorIndex: null,
        excerpt: null,
      };
    }
    const stale = notes.some((n) => n.revision_hash !== currentHash);
    const { line: current, anyFound, lineOf } = resolveGroup(notes, locate);
    // Stored anchor while unchanged; the relocation once stale; null when stale
    // and unfindable, so no label is guessed.
    const anchorIndex = !stale ? Number(key.split('-')[0]) - 1 : current ? current - 1 : null;
    const heading = anchorIndex === null ? null : (sections.get(anchorIndex) ?? null);
    const section = sectionLabel(heading?.text ?? null);
    const label = section ?? (anchorIndex === null ? UNKNOWN_SECTION : NO_SECTION);
    // Elided here so both presentations cut it identically.
    let excerpt = null;
    if (anchorIndex !== null) {
      const text = excerptAt(sourceLines, anchorIndex);
      if (text) excerpt = text.length > EXCERPT_MAX ? `${text.slice(0, EXCERPT_MAX)}…` : text;
    }
    return {
      key,
      notes,
      entries,
      stale,
      current,
      anyFound,
      lineOf,
      anchorIndex,
      section,
      label,
      excerpt,
      // Which section this IS: the heading's line, or the label for the
      // headingless buckets (a string never collides with a number).
      sectionKey: heading ? heading.line : label,
    };
  });

  // The round's shape before reading it: seven notes on one section is a
  // rewrite, seven across seven is small edits. Counts notes, not entries.
  // Bucketed by the heading's LINE, not its text — repeated or truncated titles
  // would otherwise merge two clusters into one.
  const bySection = new Map();
  for (const group of groups) {
    const bucket = bySection.get(group.sectionKey);
    if (bucket) bucket.count += group.notes.length;
    else bySection.set(group.sectionKey, { label: group.label, count: group.notes.length });
  }

  return {
    groups,
    sections: [...bySection.values()],
    closedEntries: collapseDuplicates(closedRows),
    open: rows.length,
    closed: closedRows.length,
    drifted,
    reviewers: new Set(rows.map((r) => r.reviewer)).size,
  };
}

/**
 * The whole pulled review file. It is also the MANIFEST: `just galley-close`
 * closes exactly the ids printed here. `pulledAt` is a parameter so a test can
 * assert on the whole document.
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
  const { groups, sections: bySection, closedEntries, drifted, reviewers } = reviewModel({
    sourceLines,
    currentHash,
    rows,
    closedRows,
  });

  const lines = [];
  lines.push(`# Review notes — ${slug}`);
  lines.push('');
  lines.push(`Pulled ${pulledAt.toISOString()} from \`${database}\`.`);
  const openLabel = `${rows.length} open note${rows.length === 1 ? '' : 's'}`;
  lines.push(
    closedRows.length > 0
      ? `${openLabel}, ${reviewers} reviewer(s) — plus ${closedRows.length} closed, below.`
      : `${openLabel}, ${reviewers} reviewer(s).`,
  );
  lines.push('');

  // Skipped for a single bucket, which restates the total.
  if (bySection.length > 1) {
    lines.push('Notes by section:');
    lines.push('');
    const width = Math.max(...bySection.map(({ label }) => label.length));
    pushFenced(
      lines,
      bySection.map(({ label, count }) => `${label.padEnd(width)}  ${count}`).join('\n'),
    );
    lines.push('');
  }

  // The manifest contract, stated where a hand-editor will see it.
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

  for (const { key, entries, stale, current, anyFound, lineOf, excerpt, section } of groups) {
    if (key === 'general') {
      lines.push('## Whole-draft notes');
    } else {
      let heading = `## Line ${key}`;
      if (section) heading += ` · ${section}`;
      if (stale) {
        if (current) {
          heading += ` — now line ${current}`;
        } else if (anyFound) {
          // Found, but at different lines: each note says where, below.
          heading += ' — ⚠ revision drift, notes relocated individually below';
        } else {
          heading += ' — ⚠ revision drift, quote not found';
        }
      }
      lines.push(heading);
      if (excerpt) {
        lines.push('');
        pushFenced(lines, excerpt, 'md');
      }
    }
    lines.push('');

    // Passages already spoken for, per reviewer (two editors on one sentence is
    // ordinary). Joined on NUL, which neither field can hold. Keep it the
    // ESCAPE `\0`: a raw NUL makes this file binary to grep and rg, which then
    // skip it silently.
    const spokenFor = new Set();

    for (const { notes: same } of entries) {
      const note = same[0];
      const noteLine = lineOf?.get(note);
      const passage = note.quote ? `${note.reviewer}\0${note.quote}` : null;

      const detail = [];
      // Per-note relocation, when the heading could not claim one.
      if (key !== 'general' && !current && noteLine) detail.push(`now line ${noteLine}`);
      if (passage !== null && spokenFor.has(passage)) detail.push(SAME_PASSAGE);
      if (passage !== null) spokenFor.add(passage);

      // ONE META LINE PER ID, so a collapsed duplicate is still closable.
      for (const dupe of same) {
        lines.push(
          noteMetaLine({
            reviewer: dupe.reviewer,
            kind: dupe.kind,
            when: isoDay(dupe.created_at),
            detail: detail.length > 0 ? detail.join(' · ') : null,
            id: dupe.id,
          }),
        );
      }
      lines.push('');
      // Unlocated: hand over the context the note was written against.
      const hint = key !== 'general' && !noteLine ? contextHint(note) : null;
      pushNoteContent(lines, note, hint);
    }
    lines.push('---');
    lines.push('');
  }

  // ── closed rounds (--all only) ───────────────────────
  //
  // Flat and unanchored on purpose: a record of what was said, not a pointer
  // into the current draft.
  if (closedRows.length > 0) {
    // Imported, not retyped: the scan stops at this exact string.
    lines.push(CLOSED_HEADING);
    lines.push('');
    lines.push(
      `${closedRows.length} note(s) from round(s) already applied or declined. ` +
        `Re-open one with \`just galley-reopen ${slug} --note <id>\`.`,
    );
    lines.push('');
    for (const { notes: same } of closedEntries) {
      for (const note of same) {
        lines.push(
          noteMetaLine({
            reviewer: note.reviewer,
            kind: note.kind,
            when: isoDay(note.created_at),
            detail: `closed ${isoDay(note.closed_at)}`,
            id: note.id,
          }),
        );
      }
      lines.push('');
      pushNoteContent(lines, same[0]);
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
