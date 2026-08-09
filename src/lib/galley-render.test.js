// What the pulled review file is allowed to say.
//
// The rules under test are the ones that fail QUIETLY. A pull that crashes gets
// noticed; a pull that prints "now line 88" over a note that was never about
// line 88 gets committed, handed to Claude alongside the .mdx, and applied to the
// wrong passage. Nothing anywhere would say so — which is the same argument that
// put galley-relocate.js and galley-manifest.js under test.
//
// Nothing here does I/O. scripts/galley-pull.mjs keeps the argv, the .mdx read,
// the D1 query and the write; everything it hands to renderReviewFile is built
// below by hand.

import assert from 'node:assert/strict';
import test from 'node:test';
import { NOTE_ID_RE, noteIdsInMarkdown } from './galley-manifest.js';
import {
  collapseDuplicates,
  contextHint,
  excerptAt,
  groupByAnchor,
  isoDay,
  renderReviewFile,
  resolveGroup,
  sectionMap,
} from './galley-render.js';

const HASH = 'a'.repeat(64);
const OLD_HASH = 'b'.repeat(64);

// Ids have to be real UUIDs: the manifest scan checks the shape before it
// accepts one, so a placeholder would make the round-trip test below vacuous.
const ID = (n) => `0000000${n}-1111-2222-3333-444444444444`;

/** A note with everything defaulted, so each test states only what it is about. */
function note(over = {}) {
  return {
    id: ID(1),
    reviewer: 'jd',
    kind: 'comment',
    src_start: 10,
    src_end: 10,
    quote: null,
    prefix: null,
    suffix: null,
    body: 'Tighten this.',
    suggestion: null,
    created_at: Date.UTC(2026, 4, 10),
    closed_at: null,
    revision_hash: HASH,
    ...over,
  };
}

function render(over = {}) {
  return renderReviewFile({
    slug: 'my-draft',
    sourcePath: 'src/content/blog/my-draft.mdx',
    sourceLines: ['---', 'title: x', '---', '', 'The first paragraph.'],
    currentHash: HASH,
    rows: [],
    closedRows: [],
    database: 'production',
    pulledAt: new Date('2026-05-11T09:00:00.000Z'),
    ...over,
  });
}

// ── isoDay ───────────────────────────────────────────

test('isoDay renders epoch ms as a UTC day', () => {
  assert.equal(isoDay(Date.UTC(2026, 4, 10, 23, 59)), '2026-05-10');
  assert.equal(isoDay(new Date('2026-05-10T00:00:00Z')), '2026-05-10');
});

// ── grouping ─────────────────────────────────────────

test('groups by anchor, in source order, with whole-draft notes last', () => {
  const rows = [
    note({ id: ID(1), src_start: null, src_end: null }),
    note({ id: ID(2), src_start: 90, src_end: 92 }),
    note({ id: ID(3), src_start: 12, src_end: 14 }),
    note({ id: ID(4), src_start: 90, src_end: 92 }),
  ];
  const grouped = groupByAnchor(rows);
  assert.deepEqual(
    grouped.map(([key, notes]) => [key, notes.length]),
    [
      ['12-14', 1],
      ['90-92', 2],
      ['general', 1],
    ],
  );
});

test('groups by line number, not by string — 9 sorts before 90', () => {
  const rows = [note({ id: ID(1), src_start: 90 }), note({ id: ID(2), src_start: 9 })];
  assert.deepEqual(
    groupByAnchor(rows).map(([key]) => key),
    ['9-10', '90-10'],
  );
});

// ── the relocation-agreement rule ────────────────────
//
// The bug this exists to prevent: notes share an anchor whenever they were filed
// against the same BLOCK, but they can quote different sentences within it.

test('a group claims a relocation only when every quoted note agrees', () => {
  const notes = [note({ id: ID(1), quote: 'alpha' }), note({ id: ID(2), quote: 'beta' })];
  const locate = (quote) => (quote === 'alpha' ? 40 : 40);
  assert.equal(resolveGroup(notes, locate).line, 40);
});

test('a group claims NOTHING when its notes resolve to different lines', () => {
  const notes = [note({ id: ID(1), quote: 'alpha' }), note({ id: ID(2), quote: 'beta' })];
  const locate = (quote) => (quote === 'alpha' ? 40 : 88);
  const group = resolveGroup(notes, locate);
  assert.equal(group.line, null, 'must not pick one of the two arbitrarily');
  assert.equal(group.anyFound, true, 'but both were found — that is not "quote not found"');
});

test('one unfindable note in a group withdraws the group-wide relocation', () => {
  const notes = [note({ id: ID(1), quote: 'alpha' }), note({ id: ID(2), quote: 'gone' })];
  const locate = (quote) => (quote === 'alpha' ? 40 : null);
  const group = resolveGroup(notes, locate);
  assert.equal(group.line, null);
  assert.equal(group.anyFound, true);
});

test('a group with no findable quotes reports nothing found', () => {
  const notes = [note({ id: ID(1), quote: 'gone' })];
  const group = resolveGroup(notes, () => null);
  assert.equal(group.line, null);
  assert.equal(group.anyFound, false);
});

test('resolveGroup does not write to the rows it is given', () => {
  const rows = [note({ id: ID(1), quote: 'alpha' })];
  const before = JSON.stringify(rows);
  resolveGroup(rows, () => 40);
  assert.equal(JSON.stringify(rows), before, 'D1 rows belong to the caller');
});

// ── how that reaches the document ────────────────────

test('a drifted group that agrees puts "now line N" on the heading', () => {
  const { markdown } = render({
    rows: [note({ src_start: 5, src_end: 5, quote: 'The first paragraph.', revision_hash: OLD_HASH })],
  });
  assert.match(markdown, /## Line 5-5 — now line 5/);
});

test('a drifted group that disagrees relocates per note, not on the heading', () => {
  const sourceLines = ['alpha here', 'padding', 'beta here'];
  const { markdown } = render({
    sourceLines,
    rows: [
      note({ id: ID(1), src_start: 9, src_end: 9, quote: 'alpha here', revision_hash: OLD_HASH }),
      note({ id: ID(2), src_start: 9, src_end: 9, quote: 'beta here', revision_hash: OLD_HASH }),
    ],
  });
  assert.match(markdown, /notes relocated individually below/);
  assert.doesNotMatch(markdown, /## Line 9-9 — now line/);
  // Each note says where its OWN passage went.
  assert.match(markdown, /now line 1 · `00000001/);
  assert.match(markdown, /now line 3 · `00000002/);
});

test('a drifted group with no findable quote says so rather than guessing', () => {
  const { markdown } = render({
    rows: [note({ quote: 'text that is not in the source', revision_hash: OLD_HASH })],
  });
  assert.match(markdown, /⚠ revision drift, quote not found/);
});

test('an UNCHANGED file excerpts from the stored anchor, not from the quote', () => {
  // The quote resolves to line 1, but the file has not drifted — so the stored
  // anchor is authoritative and the excerpt must come from line 5. Preferring the
  // relocation here is what puts "## Line 5-5" above someone else's prose.
  const { markdown } = render({
    sourceLines: ['The first paragraph.', '', '', '', 'Line five is different.'],
    rows: [note({ src_start: 5, src_end: 5, quote: 'The first paragraph.' })],
  });
  assert.match(markdown, /Line five is different\./);
  assert.doesNotMatch(markdown, /## Line 5-5 — now line/);
});

test('an unanchored note lands under Whole-draft notes with no line claim', () => {
  const { markdown } = render({ rows: [note({ src_start: null, src_end: null })] });
  assert.match(markdown, /## Whole-draft notes/);
  assert.doesNotMatch(markdown, /now line/);
});

// ── excerpts ─────────────────────────────────────────

test('excerptAt skips blanks and code fences to the first line with content', () => {
  assert.equal(excerptAt(['', '```js', 'const x = 1;'], 0), 'const x = 1;');
  assert.equal(excerptAt(['', '~~~', 'tilde fenced'], 0), 'tilde fenced');
});

test('excerptAt gives up rather than ranging far from the anchor', () => {
  assert.equal(excerptAt(['', '', '', '', 'too far'], 0), null);
});

// ── section labels ───────────────────────────────────
//
// What the file could not say before: that seven notes on three different line
// ranges were all one section of the post. A cluster is the thing you want to
// see before reading any single note, and finding it by reading all 51 and
// noticing is not a method.

// 1-based lines: 6 intro, 10 under the h2, 14 under the h3.
const SECTIONED = [
  '---',
  'title: x',
  '# a yaml comment, not a heading',
  '---',
  '',
  'Intro paragraph.',
  '',
  '## Where AI fell short',
  '',
  'First body line.',
  '',
  '### Know what only you can decide',
  '',
  'Second body line.',
];

test('sectionMap resolves each line to the heading above it', () => {
  const map = sectionMap(SECTIONED);
  assert.equal(map.get(5), null, 'the intro is before any heading');
  // The heading's own line rides along: it is what says whether two groups are
  // in the same section, which the text alone cannot answer.
  assert.deepEqual(map.get(9), { line: 7, text: 'Where AI fell short' });
  assert.deepEqual(map.get(13), { line: 11, text: 'Know what only you can decide' });
});

test('the nearest heading wins, whatever its level', () => {
  // The h3 is inside the h2. The specific one is the useful one.
  const { markdown } = render({
    sourceLines: SECTIONED,
    rows: [note({ src_start: 14, src_end: 14 })],
  });
  assert.match(markdown, /^## Line 14-14 · Know what only you can decide$/m);
});

test('a heading label lands on the group heading', () => {
  const { markdown } = render({
    sourceLines: SECTIONED,
    rows: [note({ src_start: 10, src_end: 10 })],
  });
  assert.match(markdown, /^## Line 10-10 · Where AI fell short$/m);
});

test('frontmatter is not scanned for headings', () => {
  // `# a yaml comment` is a comment in the frontmatter block, and labelling the
  // intro with it would be worse than labelling nothing.
  const { markdown } = render({
    sourceLines: SECTIONED,
    rows: [note({ src_start: 6, src_end: 6 })],
  });
  assert.match(markdown, /^## Line 6-6$/m, 'no section, because there is none yet');
});

test('a heading inside a fenced block is not a heading', () => {
  const sourceLines = [
    '## Real heading',
    '',
    '```md',
    '## Fake heading in a fence',
    '```',
    '',
    'Body line.',
  ];
  assert.deepEqual(sectionMap(sourceLines).get(6), { line: 0, text: 'Real heading' });
});

test('a fence closes only on its own character at its own length', () => {
  // Same CommonMark rule the manifest scan follows. A toggle would flip on the
  // inner fence and hand every later line the wrong section.
  const sourceLines = ['## Real heading', '````md', '```', '## Fake', '````', 'Body line.'];
  assert.deepEqual(sectionMap(sourceLines).get(5), { line: 0, text: 'Real heading' });
});

test('a stale group that cannot be relocated gets NO section label', () => {
  // Its stored line number means nothing in the file as it stands, so a heading
  // looked up at that index would name a section the note was never in.
  const { markdown } = render({
    sourceLines: SECTIONED,
    rows: [note({ src_start: 10, src_end: 10, quote: 'gone from the file', revision_hash: OLD_HASH })],
  });
  assert.match(markdown, /^## Line 10-10 — ⚠ revision drift, quote not found$/m);
});

test('a stale group that relocates is labelled from where it moved TO', () => {
  const { markdown } = render({
    sourceLines: SECTIONED,
    rows: [note({ src_start: 4, src_end: 4, quote: 'Second body line.', revision_hash: OLD_HASH })],
  });
  assert.match(markdown, /^## Line 4-4 · Know what only you can decide — now line 14$/m);
});

// ── the section summary ──────────────────────────────

test('the header counts notes by section, in source order', () => {
  const { markdown } = render({
    sourceLines: SECTIONED,
    rows: [
      note({ id: ID(1), src_start: 14, src_end: 14 }),
      note({ id: ID(2), src_start: 10, src_end: 10 }),
      note({ id: ID(3), src_start: 14, src_end: 14 }),
      note({ id: ID(4), src_start: 6, src_end: 6 }),
    ],
  });
  const summary = markdown.split('Notes by section:')[1].split('```')[1];
  assert.deepEqual(
    summary
      .trim()
      .split('\n')
      .map((line) => line.trim().replace(/\s{2,}/, ' · ')),
    [
      '(before the first heading) · 1',
      'Where AI fell short · 1',
      'Know what only you can decide · 2',
    ],
  );
});

test('two sections with the same words are two buckets, not one', () => {
  // The summary's entire claim is cluster size, so merging these misreports the
  // round: one bucket of two says "rewrite" where two buckets of one say "two
  // small edits". Bucketed on the heading's line for exactly this — nothing in
  // the text tells the two apart, and SECTION_MAX can truncate two long ones to
  // the same string besides.
  const sourceLines = [
    '## Part two',
    '',
    '### What worked',
    '',
    'body A',
    '',
    '## Part three',
    '',
    '### What worked',
    '',
    'body B',
  ];
  const { markdown } = render({
    sourceLines,
    rows: [
      note({ id: ID(1), src_start: 5, src_end: 5 }),
      note({ id: ID(2), src_start: 11, src_end: 11 }),
    ],
  });
  const summary = markdown.split('Notes by section:')[1].split('```')[1];
  assert.deepEqual(
    summary
      .trim()
      .split('\n')
      .map((line) => line.trim().replace(/\s{2,}/, ' · ')),
    ['What worked · 1', 'What worked · 1'],
  );
});

test('two groups under one heading are one bucket', () => {
  // The other direction of the same key. These are different line ranges — two
  // groups, two headings in the body — and they are one section.
  const { markdown } = render({
    sourceLines: SECTIONED,
    rows: [
      note({ id: ID(1), src_start: 8, src_end: 8 }),
      note({ id: ID(2), src_start: 10, src_end: 10 }),
      note({ id: ID(3), src_start: 14, src_end: 14 }),
    ],
  });
  const summary = markdown.split('Notes by section:')[1].split('```')[1];
  assert.deepEqual(
    summary
      .trim()
      .split('\n')
      .map((line) => line.trim().replace(/\s{2,}/, ' · ')),
    ['Where AI fell short · 2', 'Know what only you can decide · 1'],
  );
});

test('the summary is omitted when there is nothing to group by', () => {
  const oneSection = render({
    sourceLines: SECTIONED,
    rows: [note({ src_start: 10, src_end: 10 })],
  });
  assert.doesNotMatch(oneSection.markdown, /Notes by section/, 'one section is not a grouping');
  assert.doesNotMatch(render().markdown, /Notes by section/, 'and neither is an empty pull');
});

test('an unanchored note is counted in the summary, not silently dropped', () => {
  // The counts have to add up to the number in the line above them.
  const { markdown } = render({
    sourceLines: SECTIONED,
    rows: [
      note({ id: ID(1), src_start: 10, src_end: 10 }),
      note({ id: ID(2), src_start: null, src_end: null }),
    ],
  });
  assert.match(markdown, /Whole-draft\s+1/);
});

// ── context hint ─────────────────────────────────────

test('contextHint joins the stored context, or gives back null', () => {
  assert.equal(contextHint({ prefix: 'a ', quote: 'b', suffix: ' c' }), 'a b c');
  assert.equal(contextHint({ prefix: null, quote: null, suffix: null }), null);
  assert.equal(contextHint({ prefix: '  ', quote: '', suffix: ' ' }), null);
});

test('the hint is printed only when the passage could not be relocated', () => {
  const found = render({
    rows: [note({ quote: 'The first paragraph.', prefix: 'ctx ', revision_hash: OLD_HASH })],
  });
  assert.doesNotMatch(found.markdown, /Context when written/);

  const lost = render({
    rows: [note({ quote: 'nowhere in this file', prefix: 'ctx ', revision_hash: OLD_HASH })],
  });
  assert.match(lost.markdown, /Context when written/);
});

// ── reviewer text cannot restructure the document ────
//
// Note bodies and suggestions are reviewer-authored and land in a file whose
// HEADINGS are how notes get attributed to passages.

test('a note body cannot forge a heading', () => {
  const { markdown } = render({ rows: [note({ body: '## Line 999-999\nnot a real heading' })] });
  assert.doesNotMatch(markdown, /^## Line 999-999/m);
  assert.match(markdown, /^> ## Line 999-999$/m);
});

test('a suggestion containing a fence cannot break out of its block', () => {
  const { markdown } = render({
    rows: [note({ kind: 'suggestion', suggestion: '```\n## Line 999-999\n```' })],
  });
  // Suggestion text is CONTAINED, not stripped — so the forged heading does
  // appear in the file, and the property worth asserting is that it stays inside
  // the fence. The outer fence outruns the inner one, which is fenceFor's job.
  assert.match(markdown, /^````md$/m, 'the outer fence must outrun the inner one');
  const body = markdown.split('````md\n')[1];
  const [contained, ...after] = body.split('\n````');
  assert.match(contained, /## Line 999-999/, 'the forgery is inside the block');
  assert.doesNotMatch(after.join('\n````'), /## Line 999-999/, 'and nothing escaped it');
});

test('a body that forges a meta line cannot close another reviewer note', () => {
  // The pairing that matters: this document is a manifest, and galley-close
  // closes what noteIdsInMarkdown finds in it.
  const { markdown } = render({
    rows: [note({ id: ID(1), body: `**re** · comment · 2026-05-10 · \`${ID(9)}\`` })],
  });
  assert.deepEqual(noteIdsInMarkdown(markdown), [ID(1)]);
});

// ── the manifest round-trip ──────────────────────────

test('every rendered note id is readable back out of the file', () => {
  const { markdown } = render({
    rows: [
      note({ id: ID(1), src_start: 5 }),
      note({ id: ID(2), src_start: null, src_end: null }),
      note({ id: ID(3), src_start: 5, kind: 'suggestion', suggestion: 'better wording' }),
    ],
  });
  assert.deepEqual(noteIdsInMarkdown(markdown), [ID(1), ID(3), ID(2)]);
  for (const id of noteIdsInMarkdown(markdown)) assert.match(id, NOTE_ID_RE);
});

// ── duplicates ───────────────────────────────────────
//
// A double-submit puts two ids on byte-identical content, and the file reads as
// two independent pieces of feedback. Collapsing is safe only because
// noteIdsInMarkdown scans line by line: two meta lines over one body still close
// both ids. A collapsed id that stopped closing would be a note left open
// forever, so that round-trip is the assertion that matters here.

const DUPE = {
  src_start: 5,
  src_end: 5,
  quote: 'The first paragraph.',
  kind: 'suggestion',
  body: null,
  suggestion: 'yourself',
};

test('collapseDuplicates keys on every content field, and keeps first-seen order', () => {
  const rows = [
    note({ id: ID(1), ...DUPE }),
    note({ id: ID(2), body: 'different' }),
    note({ id: ID(3), ...DUPE }),
  ];
  assert.deepEqual(
    collapseDuplicates(rows).map((entry) => entry.ids),
    [[ID(1), ID(3)], [ID(2)]],
  );
});

test('a different prefix is a different note — same words, other occurrence', () => {
  const rows = [note({ id: ID(1), ...DUPE, prefix: 'one ' }), note({ id: ID(2), ...DUPE, prefix: 'two ' })];
  assert.equal(collapseDuplicates(rows).length, 2);
});

test('an exact duplicate prints once and still closes both ids', () => {
  const { markdown } = render({ rows: [note({ id: ID(1), ...DUPE }), note({ id: ID(2), ...DUPE })] });
  assert.deepEqual(noteIdsInMarkdown(markdown), [ID(1), ID(2)], 'both ids stay closable');
  assert.equal(markdown.match(/^yourself$/gm).length, 1, 'but the content appears once');
  assert.match(markdown, /`00000001-[\d-]+`\n\*\*jd\*\*/, 'the two meta lines are adjacent');
});

test('duplicates are collapsed in the closed appendix too', () => {
  const closed = { ...DUPE, closed_at: Date.UTC(2026, 4, 9) };
  const { markdown } = render({
    closedRows: [note({ id: ID(1), ...closed }), note({ id: ID(2), ...closed })],
  });
  assert.equal(markdown.match(/^yourself$/gm).length, 1);
});

// ── a second note on the same passage ────────────────
//
// The case this exists for: a reviewer filed "up front -> upfront", then filed
// "actually nvm" on the same words. Applying the withdrawn one was avoided only
// because listNotes orders by created_at and the pair happened to land adjacent.
// The marker is deliberately neutral — same-reviewer-same-quote catches a
// retraction and an afterthought alike, and only the adjacency is certain.

test('a second note on the same words by the same reviewer is marked', () => {
  const { markdown } = render({
    rows: [
      note({ id: ID(1), quote: 'up front', kind: 'suggestion', suggestion: 'upfront', body: null }),
      note({ id: ID(2), quote: 'up front', body: 'actually nvm' }),
    ],
  });
  assert.doesNotMatch(markdown, /↳ same passage as above · `00000001/, 'never the first');
  assert.match(markdown, /↳ same passage as above · `00000002/);
});

test('two reviewers on the same words are not a follow-up', () => {
  const { markdown } = render({
    rows: [
      note({ id: ID(1), reviewer: 'jd', quote: 'up front' }),
      note({ id: ID(2), reviewer: 're', quote: 'up front' }),
    ],
  });
  assert.doesNotMatch(markdown, /same passage as above/);
});

test('notes without a quote are never marked', () => {
  const { markdown } = render({
    rows: [note({ id: ID(1), quote: null }), note({ id: ID(2), quote: null })],
  });
  assert.doesNotMatch(markdown, /same passage as above/);
});

test('a collapsed duplicate does not mark itself', () => {
  // Collapse runs first, so the pair is one entry by the time this pass sees it.
  const { markdown } = render({ rows: [note({ id: ID(1), ...DUPE }), note({ id: ID(2), ...DUPE })] });
  assert.doesNotMatch(markdown, /same passage as above/);
});

test('the marker composes with a per-note relocation', () => {
  const sourceLines = ['alpha here', 'padding', 'beta here'];
  const { markdown } = render({
    sourceLines,
    rows: [
      note({ id: ID(1), src_start: 9, src_end: 9, quote: 'alpha here', revision_hash: OLD_HASH }),
      note({ id: ID(2), src_start: 9, src_end: 9, quote: 'beta here', revision_hash: OLD_HASH }),
      note({ id: ID(3), src_start: 9, src_end: 9, quote: 'beta here', body: 'and another thing', revision_hash: OLD_HASH }),
    ],
  });
  assert.match(markdown, /now line 3 · ↳ same passage as above · `00000003/);
});

test('the marker is scoped to one group', () => {
  const { markdown } = render({
    rows: [
      note({ id: ID(1), src_start: 5, src_end: 5, quote: 'up front' }),
      note({ id: ID(2), src_start: 40, src_end: 40, quote: 'up front' }),
    ],
  });
  assert.doesNotMatch(markdown, /same passage as above/);
});

test('closed notes are below the cut and are NOT part of the manifest', () => {
  const { markdown, closed } = render({
    rows: [note({ id: ID(1) })],
    closedRows: [note({ id: ID(2), closed_at: Date.UTC(2026, 4, 9), revision_hash: OLD_HASH })],
  });
  assert.equal(closed, 1);
  assert.match(markdown, /## Closed notes/);
  assert.match(markdown, /closed 2026-05-09/);
  assert.deepEqual(noteIdsInMarkdown(markdown), [ID(1)], 'a closed id must not be re-closable');
});

// ── counts and header ────────────────────────────────

test('drift is counted over open notes only', () => {
  const { drifted, open } = render({
    rows: [note({ id: ID(1) }), note({ id: ID(2), revision_hash: OLD_HASH })],
    closedRows: [note({ id: ID(3), revision_hash: OLD_HASH, closed_at: 1 })],
  });
  assert.equal(open, 2);
  assert.equal(drifted, 1, 'a closed note is drifted by definition and must not be counted');
});

test('the header names the database and the reviewer count', () => {
  const { markdown } = render({
    rows: [note({ id: ID(1), reviewer: 'jd' }), note({ id: ID(2), reviewer: 're' })],
    database: 'local',
  });
  assert.match(markdown, /Pulled 2026-05-11T09:00:00\.000Z from `local`\./);
  assert.match(markdown, /2 open notes, 2 reviewer\(s\)\./);
});

test('one note is not pluralised', () => {
  assert.match(render({ rows: [note()] }).markdown, /1 open note, 1 reviewer/);
});

test('an empty pull is still a valid, id-free document', () => {
  const { markdown, open } = render();
  assert.equal(open, 0);
  assert.match(markdown, /0 open notes, 0 reviewer\(s\)\./);
  assert.deepEqual(noteIdsInMarkdown(markdown), []);
  assert.ok(markdown.endsWith('\n'));
});

test('the drift banner appears only when something drifted', () => {
  assert.doesNotMatch(render({ rows: [note()] }).markdown, /written against an earlier revision/);
  assert.match(
    render({ rows: [note({ revision_hash: OLD_HASH })] }).markdown,
    /\*\*1 of these were written against an earlier revision\.\*\*/,
  );
});
