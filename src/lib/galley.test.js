// Unit tests for galley note validation. Run via `npm test`.
//
// The endpoint is thin on purpose — it authorises, then delegates every
// judgement about a note's contents to validateNote. These tests are therefore
// the real coverage for what a reviewer is allowed to submit; smoke only
// checks that the endpoint is wired to them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, KINDS, parseSrc, sha256Hex, validateNote } from './galley.js';
import { SLUG_RE } from './preview.js';

/** A minimal valid comment. */
const comment = (over = {}) => ({ slug: 'my-draft', kind: 'comment', body: 'This verb is jargon.', ...over });

// ── src ranges ───────────────────────────────────────

test('parseSrc reads an anchor', () => {
  assert.deepEqual(parseSrc('42-47'), { start: 42, end: 47 });
});

test('parseSrc accepts a single-line anchor', () => {
  assert.deepEqual(parseSrc('8-8'), { start: 8, end: 8 });
});

test('parseSrc rejects malformed and impossible ranges', () => {
  for (const bad of [null, undefined, 42, '', '42', '42-', '-47', 'a-b', '47-42', '0-3', '1-2-3', ' 4-5 ']) {
    assert.equal(parseSrc(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

// ── hashing ──────────────────────────────────────────

test('sha256Hex matches a known digest', async () => {
  // Pins the encoding (UTF-8) and the format (lowercase hex). The pull script
  // hashes the same file with node:crypto, so any drift here breaks drift
  // detection itself.
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('sha256Hex is sensitive to frontmatter-only changes', async () => {
  // The reason the hash covers the whole file. These two differ only in a
  // frontmatter tag, but every body line below it has shifted by one.
  const before = '---\ntitle: "A"\n---\n\nBody line.\n';
  const after = '---\ntitle: "A"\ntags: ["x"]\n---\n\nBody line.\n';
  assert.notEqual(await sha256Hex(before), await sha256Hex(after));
});

// ── validation ───────────────────────────────────────

test('a minimal comment validates', () => {
  const result = validateNote(comment());
  assert.equal(result.ok, true);
  assert.equal(result.note.body, 'This verb is jargon.');
  assert.equal(result.note.kind, 'comment');
});

test('kind defaults to comment', () => {
  const result = validateNote({ slug: 'my-draft', body: 'note' });
  assert.equal(result.ok, true);
  assert.equal(result.note.kind, 'comment');
});

test('an anchor is parsed into start and end', () => {
  const result = validateNote(comment({ src: '42-47' }));
  assert.equal(result.note.srcStart, 42);
  assert.equal(result.note.srcEnd, 47);
});

test('a note with no anchor is allowed — it is a whole-draft comment', () => {
  const result = validateNote(comment());
  assert.equal(result.ok, true);
  assert.equal(result.note.srcStart, null);
  assert.equal(result.note.srcEnd, null);
});

test('a malformed anchor is rejected rather than dropped', () => {
  // Dropping it would file a passage-specific note as a whole-draft one and
  // quietly lose the location the editor picked.
  assert.deepEqual(validateNote(comment({ src: '47-42' })), { ok: false, error: 'invalid_src' });
});

test('quote, prefix and suffix are carried through trimmed', () => {
  const result = validateNote(comment({ quote: '  diffs against  ', prefix: ' a ', suffix: ' b ' }));
  assert.equal(result.note.quote, 'diffs against');
  assert.equal(result.note.prefix, 'a');
  assert.equal(result.note.suffix, 'b');
});

test('a comment requires a body', () => {
  assert.deepEqual(validateNote({ slug: 'my-draft', kind: 'comment' }), { ok: false, error: 'body_required' });
  assert.deepEqual(validateNote(comment({ body: '   ' })), { ok: false, error: 'body_required' });
});

test('a suggestion requires replacement text but not prose', () => {
  const bare = validateNote({ slug: 'my-draft', kind: 'suggestion', suggestion: 'compares against' });
  assert.equal(bare.ok, true);
  assert.equal(bare.note.body, null);
  assert.equal(bare.note.suggestion, 'compares against');

  assert.deepEqual(
    validateNote({ slug: 'my-draft', kind: 'suggestion', body: 'reword this' }),
    { ok: false, error: 'suggestion_required' },
  );
});

test('an unknown kind is rejected', () => {
  assert.deepEqual(validateNote(comment({ kind: 'redline' })), { ok: false, error: 'invalid_kind' });
});

test('a bad slug shape is rejected', () => {
  for (const slug of ['My-Draft', '../etc/passwd', 'has space', '', 'has.dot']) {
    assert.deepEqual(validateNote(comment({ slug })), { ok: false, error: 'invalid_slug' });
  }
});

test('oversize fields are rejected by name, not truncated', () => {
  assert.deepEqual(
    validateNote(comment({ body: 'x'.repeat(LIMITS.body + 1) })),
    { ok: false, error: 'body_too_long' },
  );
  assert.deepEqual(
    validateNote(comment({ quote: 'x'.repeat(LIMITS.quote + 1) })),
    { ok: false, error: 'quote_too_long' },
  );
  assert.deepEqual(
    validateNote(comment({ prefix: 'x'.repeat(LIMITS.context + 1) })),
    { ok: false, error: 'prefix_too_long' },
  );
  assert.deepEqual(
    validateNote({ slug: 'my-draft', kind: 'suggestion', suggestion: 'x'.repeat(LIMITS.suggestion + 1) }),
    { ok: false, error: 'suggestion_too_long' },
  );
});

test('a field exactly at the limit is accepted', () => {
  const result = validateNote(comment({ body: 'x'.repeat(LIMITS.body) }));
  assert.equal(result.ok, true);
});

test('non-object input is rejected without throwing', () => {
  for (const bad of [null, undefined, 'string', 42, []]) {
    const result = validateNote(bad);
    assert.equal(result.ok, false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('unknown fields are ignored rather than stored', () => {
  // The insert names its columns explicitly, so this is belt-and-braces —
  // but it pins that a client cannot smuggle a `status` or `reviewer` in.
  const result = validateNote(comment({ reviewer: 'somebody-else', status: 'resolved', id: 'x' }));
  assert.equal(result.ok, true);
  assert.equal(result.note.reviewer, undefined);
  assert.equal(result.note.status, undefined);
  assert.equal(result.note.id, undefined);
});

test('the kinds set matches what the migration allows', () => {
  assert.deepEqual([...KINDS].sort(), ['comment', 'suggestion']);
});

test('galley and preview agree on identifier shape', () => {
  // The two modules keep separate copies on purpose (authorisation vs note
  // contents). This asserts they have not drifted apart.
  for (const id of ['my-draft', 'jd', 'a-b-1']) {
    assert.equal(SLUG_RE.test(id), true);
    assert.equal(validateNote(comment({ slug: id })).ok, true);
  }
  for (const id of ['Bad', 'has.dot', 'has space']) {
    assert.equal(SLUG_RE.test(id), false);
    assert.equal(validateNote(comment({ slug: id })).ok, false);
  }
});
