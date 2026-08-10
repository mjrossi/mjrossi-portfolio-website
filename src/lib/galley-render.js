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

/** Longest section label printed, on a heading or in the summary. */
const SECTION_MAX = 56;

/** The label for notes anchored above the post's first heading. */
const NO_SECTION = '(before the first heading)';

/**
 * The summary bucket for a group whose passage could not be located at all —
 * stale, and its quote no longer in the file. Distinct from NO_SECTION, which
 * is a positive claim about where the note is.
 */
const UNKNOWN_SECTION = '(section unknown)';

/** The summary row for unanchored notes, matching the `## Whole-draft notes` heading. */
const WHOLE_DRAFT = 'Whole-draft';

/**
 * Appended to a note filed on a passage an earlier note in the same group
 * already covered. DELIBERATELY NEUTRAL: same-reviewer-same-quote catches a
 * retraction ("actually nvm" on the words just suggested) and a plain
 * afterthought alike, and only the adjacency is certain. Calling it a follow-up
 * would assert the second note revises the first, which is exactly the half this
 * cannot know.
 */
const SAME_PASSAGE = '↳ same passage as above';

// An opening or closing fence, captured so the close can be matched against it.
//
// galley-manifest.js holds the same CommonMark rule for the PULLED FILE, where
// it keeps reviewer prose from being read as note ids. This one is for the
// .mdx, and the two are separate because they scan different documents and may
// legitimately diverge; excerptAt already owned a fence literal here before
// either of the readers below needed one.
const FENCE_RE = /^\s*(`{3,}|~{3,})/;

// An ATX heading: up to three leading spaces, one to six #s, then a space.
// Setext headings (=== / --- underlines) are NOT detected — every post here is
// ATX, and an undetected heading yields no label rather than a wrong one.
const ATX_RE = /^ {0,3}(#{1,6})\s+(.*)$/;

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
    if (FENCE_RE.test(text)) continue;
    return text;
  }
  return null;
}

/**
 * Every line of the .mdx mapped to the heading it sits under, or null where
 * there isn't one yet.
 *
 * Built by ONE FORWARD PASS rather than a backward scan per lookup, because the
 * fence state is what makes it correct: a `## ` inside a fenced code block is
 * not a heading, and you cannot tell whether a line is fenced by looking only
 * at the lines above it in reverse.
 *
 * Nearest heading of ANY level wins. A note in "Know what only you can decide"
 * wants that, not the `## Five lessons` two screens up — the specific one is the
 * one that tells you where you are.
 *
 * THE VALUE CARRIES THE HEADING'S OWN LINE as well as its text, because the two
 * answer different questions: the text is what gets printed, and the line is
 * what says whether two groups are in the SAME section. A post can hold the same
 * words twice — `### What worked` under Part two and again under Part three — and
 * nothing in the text alone tells them apart.
 *
 * @param {string[]} sourceLines
 * @returns {Map<number, { line: number, text: string } | null>} 0-based line
 *   index → the heading it sits under
 */
export function sectionMap(sourceLines) {
  const map = new Map();

  // Skip the frontmatter block. `# tags are public` in there is a YAML comment,
  // and labelling the post's opening paragraph with it would be worse than
  // labelling nothing. Only the LEADING block — a later `---` is a thematic
  // break and has no bearing on this.
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
      // Close only on the same character at at least the same length —
      // CommonMark's rule, and the one galley-manifest.js follows. A boolean
      // toggle flips on a shorter inner fence and hands every line after it the
      // wrong section.
      if (found && found[1][0] === fence[0] && found[1].length >= fence.length) fence = null;
    } else if (found) {
      fence = found[1];
    } else {
      const heading = ATX_RE.exec(line);
      // Trailing #s are an optional closing sequence, not part of the text.
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
 * Notes grouped so byte-identical ones print once, in first-seen order.
 *
 * A double-submit lands two ids on the same reviewer, quote, body and
 * suggestion, and the file then reads as two independent pieces of feedback.
 *
 * SAFE ONLY BECAUSE THE MANIFEST IS LINE-BASED: the caller emits one meta line
 * per id above a single copy of the content, and noteIdsInMarkdown reads each of
 * them, so every id stays closable. An entry whose extra ids stopped being
 * printed would leave those notes open forever with nothing saying so.
 *
 * The key is every content field, prefix and suffix included: the same words
 * selected at a different occurrence in the same block are different notes, and
 * that is the only place they differ.
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
 * A section label at printable length.
 *
 * @param {string | null} text
 * @returns {string | null}
 */
function sectionLabel(text) {
  if (!text) return null;
  return text.length > SECTION_MAX ? `${text.slice(0, SECTION_MAX - 1)}…` : text;
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
 * What a review round SAYS, as a data structure.
 *
 * Split out of renderReviewFile when the Desk (/admin/<slug>) came to need the
 * same answers in HTML. Everything hard about a pull is in here — which passage
 * a group is about, whether its anchor still means anything, where it moved to,
 * what section it falls under, which notes are duplicates of each other — and
 * all of it fails SILENTLY when it is wrong: a heading claims a line the note
 * was never about, or an excerpt comes from elsewhere entirely. Two
 * implementations of that would be two chances to get it wrong, and only one of
 * them would be under test.
 *
 * So: one model, two presentations. renderReviewFile emits the markdown
 * `just galley` writes; the Desk renders HTML from the identical object.
 *
 * @param {object} args
 * @param {string[]} args.sourceLines the .mdx split on newlines
 * @param {string} args.currentHash revision hash of the .mdx as it stands
 * @param {Record<string, unknown>[]} args.rows open notes, oldest first
 * @param {Record<string, unknown>[]} [args.closedRows] closed notes
 */
export function reviewModel({ sourceLines, currentHash, rows, closedRows = [] }) {
  const locate = createLocator(sourceLines);

  // Counted over OPEN notes only. A closed note is drifted almost by definition --
  // the revision that closed it is the one that changed the file -- so counting
  // those would put a drift warning on every pull forever and train the reader to
  // ignore the one that matters.
  const drifted = rows.filter((r) => r.revision_hash !== currentHash).length;

  // Everything about a group that both the summary and the body need, resolved
  // ONCE. The section label and the excerpt must be read at the SAME index —
  // two independently computed ones is how a heading ends up naming a different
  // passage than the excerpt printed under it, which is the resolveGroup failure
  // mode one level up.
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
    // Where this group's passage is in the file as it stands. Null when the
    // group is stale and its quote could not be found: the stored line number
    // means nothing in the current file, so there is no honest place to read a
    // heading from and the label is withheld rather than guessed.
    const anchorIndex = !stale ? Number(key.split('-')[0]) - 1 : current ? current - 1 : null;
    const heading = anchorIndex === null ? null : (sections.get(anchorIndex) ?? null);
    const section = sectionLabel(heading?.text ?? null);
    const label = section ?? (anchorIndex === null ? UNKNOWN_SECTION : NO_SECTION);
    // Read at anchorIndex, the SAME index the label came from. Elided here
    // rather than at each call site so both presentations cut it identically.
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
      // Which section this IS, as opposed to what it is called. The three
      // label-only buckets have no heading to point at and key on the label
      // itself; a string and a number never collide as Map keys.
      sectionKey: heading ? heading.line : label,
    };
  });

  // Where the notes fell, before you have read any of them. A round's shape is
  // its clusters — seven notes on one section is a rewrite and seven notes
  // spread over seven is an afternoon of small edits — and nothing in a list
  // ordered by line number shows that.
  //
  // Counts NOTES, not entries, so they add up to the total even where duplicates
  // collapsed.
  //
  // BUCKETED BY THE HEADING'S LINE, NOT ITS TEXT. Two sections can carry the
  // same words — `### What worked` under Part two and again under Part three —
  // and SECTION_MAX can truncate two long ones to the same string besides.
  // Merging either pair reports one cluster of seven where the truth is four and
  // three, which is the exact inference this exists to support. Same words
  // therefore appear on two rows, in source order; the line ranges say which is
  // which.
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

  // The by-section summary — a round's shape before you have read any of it.
  // Computed in reviewModel; see there for why it buckets on the heading's LINE
  // rather than its text. Skipped below two buckets: one bucket is not a
  // grouping, it is the same fact restated.
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

  for (const { key, entries, stale, current, anyFound, lineOf, excerpt, section } of groups) {
    if (key === 'general') {
      lines.push('## Whole-draft notes');
    } else {
      // Section first, drift second: which passage this is, then what has
      // happened to it.
      let heading = `## Line ${key}`;
      if (section) heading += ` · ${section}`;
      if (stale) {
        if (current) {
          heading += ` — now line ${current}`;
        } else if (anyFound) {
          // Found, but not all in the same place — these notes share an anchor
          // while quoting different sentences. Saying "not found" here would be
          // wrong, and saying "now line N" would pick one of them arbitrarily.
          heading += ' — ⚠ revision drift, notes relocated individually below';
        } else {
          heading += ' — ⚠ revision drift, quote not found';
        }
      }
      lines.push(heading);
      // Read at the same index the section label came from — see reviewModel.
      // When the file has NOT drifted the stored anchor is authoritative by
      // definition, so it wins over a relocation: the quote resolving elsewhere
      // in an unchanged file means the anchor is the trustworthy half.
      if (excerpt) {
        lines.push('');
        pushFenced(lines, excerpt, 'md');
      }
    }
    lines.push('');

    // A passage this group has already spoken about. Keyed by reviewer as well
    // as quote: two editors landing on the same sentence is the ordinary case
    // and is not one of them revisiting it.
    //
    // Joined on NUL because it is the one character neither field can hold, so
    // no reviewer label and quote can pair up to look like a different pair. It
    // is written as the ESCAPE `\0` and must stay that way: as a raw byte in the
    // source it makes this file binary to `file`, `grep` and `rg`, all of which
    // then skip it silently — and a diff renders it as a space, which is how it
    // reads as one in review.
    const spokenFor = new Set();

    for (const { notes: same } of entries) {
      const note = same[0];
      const noteLine = lineOf?.get(note);
      const passage = note.quote ? `${note.reviewer}\0${note.quote}` : null;

      const detail = [];
      // Per-note relocation, for the case the heading could not claim one: the
      // notes in this group resolve to different lines, so each says where its
      // own passage went.
      if (key !== 'general' && !current && noteLine) detail.push(`now line ${noteLine}`);
      if (passage !== null && spokenFor.has(passage)) detail.push(SAME_PASSAGE);
      if (passage !== null) spokenFor.add(passage);

      // ONE META LINE PER ID over a single copy of the content. Every id stays
      // in the manifest — noteIdsInMarkdown reads line by line — so a collapsed
      // duplicate is still closed by `just galley-close`.
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
    // Collapsed here too — printing identical content twice is noise wherever it
    // happens. No section label and no same-passage marker: this appendix is
    // flat and unanchored by design, so neither has anything to attach to.
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
      // No context hint: these notes are not being relocated, so there is nothing
      // to point the author at.
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
