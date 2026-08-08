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
  contextHint,
  excerptAt,
  groupByAnchor,
  isoDay,
  renderReviewFile,
  resolveGroup,
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
