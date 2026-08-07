import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { NOTE_ID_RE, noteIdsInMarkdown } from './galley-manifest.js';
import { pushFenced, pushQuoted } from './galley-relocate.js';

// The ids scripts/galley-pull.mjs would print. Fixed rather than randomUUID()'d
// so a failure names the same id twice running.
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

/** The meta line galley-pull.mjs emits above a note. */
function meta(id, { reviewer = 'jd', kind = 'comment', relocated = false } = {}) {
  return `**${reviewer}** · ${kind} · 2026-05-10${relocated ? ' · now line 88' : ''} · \`${id}\``;
}

test('finds the id on a note meta line', () => {
  assert.deepEqual(noteIdsInMarkdown(`## Line 42-47\n\n${meta(A)}\n`), [A]);
});

test('finds ids across several notes, in document order', () => {
  const file = ['## Line 12-13', '', meta(A), '', '## Line 42-47', '', meta(B, { reviewer: 'mr' })].join('\n');
  assert.deepEqual(noteIdsInMarkdown(file), [A, B]);
});

test('reads the meta line galley-pull writes for a relocated note', () => {
  assert.deepEqual(noteIdsInMarkdown(meta(A, { kind: 'suggestion', relocated: true })), [A]);
});

test('deduplicates a repeated id', () => {
  assert.deepEqual(noteIdsInMarkdown(`${meta(A)}\n${meta(A)}\n`), [A]);
});

// The bug this scan was tightened for. Reviewer prose lands in this file
// blockquoted, and a reviewer can read ids straight off GET /api/galley — so a
// body-wide search let one note name another for closure.
test('ignores an id quoted inside a reviewer’s note body', () => {
  const lines = [meta(A), ''];
  pushQuoted(lines, `This duplicates the point in \`${B}\` — drop one of them.`);
  assert.deepEqual(noteIdsInMarkdown(lines.join('\n')), [A]);
});

test('ignores a whole forged meta line inside a blockquote', () => {
  const lines = [meta(A), ''];
  pushQuoted(lines, meta(B));
  assert.deepEqual(noteIdsInMarkdown(lines.join('\n')), [A]);
});

test('ignores ids inside a fenced suggestion block', () => {
  const lines = [meta(A), '', 'Suggested replacement:', ''];
  pushFenced(lines, `see \`${B}\`\n${meta(C)}`, 'md');
  assert.deepEqual(noteIdsInMarkdown(lines.join('\n')), [A]);
});

// pushFenced picks a fence longer than the longest backtick run in its content,
// so a suggestion containing ``` does not end the block early. The scan has to
// resume on that same longer fence or every id after it is swallowed.
test('resumes after a suggestion that contains a fence of its own', () => {
  const lines = [meta(A), ''];
  pushFenced(lines, '```\nnested\n```', 'md');
  lines.push('', meta(B));
  assert.deepEqual(noteIdsInMarkdown(lines.join('\n')), [A, B]);
});

// The tests above pair their inner fences, which is what let a boolean toggle
// pass them: two flips cancel. An ODD number does not, and it inverted the scan
// for the whole rest of the file. Both directions of that are below, and both
// were reproducible against the real pushFenced.
//
// The close rule is now CommonMark's — same fence character, at least as long as
// the opener — which is exactly the guarantee `fenceFor` writes to.

/** Build a pulled file: note A, a suggestion, then note B. */
function fileWithSuggestion(suggestion) {
  const lines = [meta(A), '', 'Suggested replacement:', ''];
  pushFenced(lines, suggestion, 'md');
  lines.push('', meta(B, { reviewer: 'mr' }));
  return lines.join('\n');
}

test('an unbalanced ``` inside a suggestion does not swallow later ids', () => {
  // fenceFor emits ```` so the block renders correctly; the inner ``` is content.
  assert.deepEqual(noteIdsInMarkdown(fileWithSuggestion('Open a block:\n```\nthen the code')), [A, B]);
});

test('an unbalanced ~~~ inside a suggestion does not swallow later ids', () => {
  // fenceFor only measures BACKTICK runs, so a tilde fence is never lengthened
  // around — the scan has to not care about it while inside a backtick block.
  assert.deepEqual(noteIdsInMarkdown(fileWithSuggestion('Use:\n~~~\ncode')), [A, B]);
});

// THE ONE THAT COSTS AN EXTRA ID. With the scan inverted by an odd inner fence,
// a meta-shaped line in a reviewer's own suggestion became closable — the exact
// "one note closes another reviewer's" bug META_LINE_RE was tightened for, and
// the note actually listed (B) was left open in its place.
test('an unbalanced fence cannot make a forged meta line inside a suggestion closable', () => {
  const ids = noteIdsInMarkdown(fileWithSuggestion(`Open with:\n\`\`\`\n${meta(C, { reviewer: 'mr' })}`));
  assert.ok(!ids.includes(C), 'closed a note that only appeared inside another reviewer’s suggestion');
  assert.deepEqual(ids, [A, B]);
});

// The appendix cut is per line and reached only outside a fence. As a split over
// the raw document it fired on reviewer text too, silently truncating the
// manifest — the safe direction, but it reported the remainder as notes somebody
// filed after the pull.
test('a suggestion containing the appendix heading does not truncate the manifest', () => {
  assert.deepEqual(noteIdsInMarkdown(fileWithSuggestion('Rename the section to:\n## Closed notes\n')), [A, B]);
});

// The appendix `just galley <slug> --all` writes. Those notes are already
// closed; scanning them is harmless in SQL but makes the command report
// "lists 14, closed 6" and leaves the operator hunting the other eight.
test('stops at the closed-notes appendix', () => {
  const file = [
    '## Line 42-47', '', meta(A), '',
    '## Closed notes', '',
    `**jd** · comment · 2026-04-02 · closed 2026-04-09 · \`${B}\``,
  ].join('\n');
  assert.deepEqual(noteIdsInMarkdown(file), [A]);
});

test('a file with no notes yields nothing', () => {
  assert.deepEqual(noteIdsInMarkdown('# Review notes — my-draft\n\nNo open notes.\n'), []);
});

// A pull written before ids were printed. galley-close.mjs turns the empty
// result into "re-pull to refresh it" rather than a successful close of nothing.
test('a file whose notes carry no ids yields nothing', () => {
  assert.deepEqual(noteIdsInMarkdown('## Line 42-47\n\n**jd** · comment · 2026-05-10\n'), []);
});

test('rejects a hex-shaped string that is not a UUID', () => {
  // 36 chars of the right alphabet, wrong shape — reaches the meta-line regex
  // and has to be turned away by NOTE_ID_RE.
  const notAnId = '1111111-11111-4111-8111-1111111111111';
  assert.deepEqual(noteIdsInMarkdown(`**jd** · comment · 2026-05-10 · \`${notAnId}\``), []);
});

test('NOTE_ID_RE matches a randomUUID and rejects near-misses', () => {
  assert.ok(NOTE_ID_RE.test(crypto.randomUUID()));
  // Lowercase only, which is what crypto.randomUUID() emits and therefore what
  // the id column holds. A carries no hex letters, so it cannot make this point.
  const lettered = '1f0ca9de-4b2e-4c7a-9f31-0d5e6a7b8c90';
  assert.ok(NOTE_ID_RE.test(lettered));
  assert.ok(!NOTE_ID_RE.test(lettered.toUpperCase()));
  assert.ok(!NOTE_ID_RE.test(`${A}x`));
  assert.ok(!NOTE_ID_RE.test(A.replace(/-/g, '')));
});
