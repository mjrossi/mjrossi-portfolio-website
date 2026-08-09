// The only file that knows the columns of galley_notes.
//
// Same shape and same argument as src/lib/links-store.js one table over: the
// statements run against a duck-typed store, so the operator CLI (through
// scripts/d1-store.mjs) and the worker (through its D1 binding) execute one
// copy rather than two.
//
// src/pages/api/galley.ts is the exception, and deliberately so: its INSERT
// carries the write quota as a subquery inside the statement, and its two reads
// carry the open/closed split and the per-read ceilings. That is endpoint
// policy — a bound on a leaked review link — rather than table access, and
// moving it here would put a decision about /api/galley in a module the CLI
// imports. Everything that is plain access to galley_notes lives here.
//
// A note is OPEN while `closed_at IS NULL` and closed once it holds a timestamp.
// There is no 'open' value to write -- see migrations/0003, which dropped the
// `status` column this used to pretend to use.
//
// As in links-store.js, THE SHAPE CHECKS BELOW ARE DOMAIN VALIDATION rather than
// escaping: parameters make the statements safe, scripts/d1-store.mjs makes the
// argument for the CLI half, and what these buy is a named error instead of a
// silent no-op.

import { NOTE_ID_RE } from './galley-manifest.js';
import { SLUG_RE } from './preview.js';

// ── input validation ─────────────────────────────────

function checkSlug(slug, label = 'slug') {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(`notes-store: invalid ${label} ${JSON.stringify(slug)}`);
  }
  return slug;
}

function checkNoteId(id) {
  if (typeof id !== 'string' || !NOTE_ID_RE.test(id)) {
    throw new Error(`notes-store: invalid note id ${JSON.stringify(id)}`);
  }
  return id;
}

function checkInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`notes-store: ${label} must be an integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

function checkNullableInteger(value, label) {
  if (value === null || value === undefined) return null;
  return checkInteger(value, label);
}

function checkNullableText(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    throw new Error(`notes-store: ${label} must be a string or null`);
  }
  return value;
}

/** `?, ?, ?` for a list of n values. */
function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}

// ── writes ───────────────────────────────────────────

/**
 * Close notes: mark a round finished with.
 *
 * ALWAYS scoped to the slug as well as the ids, like every write in
 * links-store.js: an id belonging to another post does nothing rather than
 * quietly closing a note on a draft the operator did not name.
 *
 * Already-closed rows are left alone (`closed_at IS NULL`), so re-running does
 * not rewrite the date a round was actually closed.
 *
 * RETURNS THE IDS IT ACTUALLY CLOSED. Every no-op here is silent by construction
 * -- an id from another post is scoped away, one that was already closed matches
 * nothing, one that never existed matches nothing -- and the caller is expected
 * to say which. `RETURNING` rather than a second SELECT so this stays one
 * round-trip and cannot race a concurrent close.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} slug
 * @param {string[]} ids
 * @returns {Promise<string[]>} ids this call closed
 */
export async function closeNotes(store, slug, ids) {
  checkSlug(slug);
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const noteIds = ids.map((id) => checkNoteId(id));
  const { results } = await store
    .prepare(
      'UPDATE galley_notes SET closed_at = ? ' +
        `WHERE slug = ? AND id IN (${placeholders(noteIds.length)}) AND closed_at IS NULL ` +
        'RETURNING id',
    )
    .bind(Date.now(), slug, ...noteIds)
    .all();
  return results.map((row) => row.id);
}

/**
 * Re-open one closed note. The undo for a mistaken close.
 *
 * Deliberately one note at a time and never bulk: closing is the routine act and
 * re-opening is the correction, so the correction should be the one that makes
 * you name what you mean. Same reasoning as revoking staying per-post while the
 * roster reads across all of them.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} slug
 * @param {string} id
 * @returns {Promise<boolean>} whether a row changed
 */
export async function reopenNote(store, slug, id) {
  checkSlug(slug);
  checkNoteId(id);
  const { results } = await store
    .prepare(
      'UPDATE galley_notes SET closed_at = NULL ' +
        'WHERE slug = ? AND id = ? AND closed_at IS NOT NULL ' +
        'RETURNING id',
    )
    .bind(slug, id)
    .all();
  return results.length > 0;
}

/**
 * Insert notes directly. A TEST FIXTURE.
 *
 * Production notes are written by src/pages/api/galley.ts through the D1 binding,
 * behind a signed review link and a write quota. This exists so smoke can seed
 * the states that endpoint cannot reach on demand -- a note against an older
 * revision, a note already closed.
 *
 * The "local database only" guard lives in scripts/notes-db.mjs, for the same
 * reason clearLinks' does: `--local` is a fact about which database a CLI was
 * pointed at, and this module does not know what a database is.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {{ id: string, slug: string, revisionHash: string, reviewer: string,
 *           kind?: string, srcStart?: number | null, srcEnd?: number | null,
 *           quote?: string | null, prefix?: string | null, suffix?: string | null,
 *           body?: string | null, suggestion?: string | null,
 *           createdAt?: number, closedAt?: number | null }[]} rows
 */
export async function seedNotes(store, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('notes-store: seedNotes needs at least one row');
  }
  const now = Date.now();
  const params = [];
  for (const row of rows) {
    const kind = row.kind ?? 'comment';
    if (kind !== 'comment' && kind !== 'suggestion') {
      throw new Error(`notes-store: invalid kind ${JSON.stringify(kind)}`);
    }
    params.push(
      checkNoteId(row.id),
      checkSlug(row.slug),
      checkNullableText(row.revisionHash, 'revisionHash'),
      checkNullableText(row.reviewer, 'reviewer'),
      kind,
      checkNullableInteger(row.srcStart, 'srcStart'),
      checkNullableInteger(row.srcEnd, 'srcEnd'),
      checkNullableText(row.quote ?? null, 'quote'),
      checkNullableText(row.prefix ?? null, 'prefix'),
      checkNullableText(row.suffix ?? null, 'suffix'),
      checkNullableText(row.body ?? null, 'body'),
      checkNullableText(row.suggestion ?? null, 'suggestion'),
      checkInteger(row.createdAt ?? now, 'createdAt'),
      checkNullableInteger(row.closedAt ?? null, 'closedAt'),
    );
  }
  const tuples = rows.map(() => `(${placeholders(14)})`).join(', ');
  await store
    .prepare(
      'INSERT INTO galley_notes (id, slug, revision_hash, reviewer, kind, src_start, src_end, ' +
        `quote, prefix, suffix, body, suggestion, created_at, closed_at) VALUES ${tuples}`,
    )
    .bind(...params)
    .run();
}

/**
 * Delete every note for the named posts. DESTRUCTIVE.
 *
 * A test-fixture helper, like clearLinks: scripts/smoke.mjs resets its rows
 * before each run. Nothing in this feature deletes a note in earnest -- closing
 * is how a note stops mattering, and it keeps the row.
 *
 * `reviewer` narrows it further, so a smoke run on a shared local database
 * clears only what it wrote and leaves a real note left there by hand alone.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string[]} slugs
 * @param {{ reviewer?: string | null }} [scope]
 */
export async function clearNotes(store, slugs, { reviewer = null } = {}) {
  // Guarded because an empty list would render `WHERE slug IN ()`, which is a
  // syntax error rather than a no-op.
  if (!Array.isArray(slugs) || slugs.length === 0) return;
  const params = slugs.map((slug) => checkSlug(slug));
  let scope = '';
  if (reviewer !== null) {
    scope = ' AND reviewer = ?';
    params.push(checkSlug(reviewer, 'reviewer'));
  }
  await store
    .prepare(
      `DELETE FROM galley_notes WHERE slug IN (${placeholders(slugs.length)})${scope}`,
    )
    .bind(...params)
    .run();
}

// ── reads ────────────────────────────────────────────

/** The column list every read below shares. */
const COLUMNS =
  'id, revision_hash, reviewer, kind, src_start, src_end, ' +
  'quote, prefix, suffix, body, suggestion, created_at, closed_at';

/**
 * Notes for one post, oldest first.
 *
 * Open only by default, because that is the working set: a closed note belongs
 * to a round the author finished with, and re-reading it every time is exactly
 * the pile-up this column was added to stop. `includeClosed` is `just galley
 * <slug> --all`, for going back through the record.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} slug
 * @param {{ includeClosed?: boolean }} [scope]
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listNotes(store, slug, { includeClosed = false } = {}) {
  checkSlug(slug);
  const scope = includeClosed ? '' : ' AND closed_at IS NULL';
  const { results } = await store
    .prepare(
      `SELECT ${COLUMNS} FROM galley_notes WHERE slug = ?${scope} ORDER BY created_at ASC`,
    )
    .bind(slug)
    .all();
  return results;
}

/**
 * How many notes each post has, in one round-trip.
 *
 * The Desk's index needs a count per post and would otherwise issue one
 * listNotes per scheduled draft — a query count that grows with the content
 * collection, on a page whose whole job is to load on a phone. Nothing else
 * needs it, which is why it counts rather than returning rows.
 *
 * Open only: a closed note belongs to a finished round and does not belong in
 * an "outstanding" number. Unscoped by post, like listAllLinks and for the same
 * reason — see that function's note about the Access-gated Desk.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @returns {Promise<Map<string, number>>} slug → open note count, posts with none absent
 */
export async function countOpenNotesBySlug(store) {
  const { results } = await store
    .prepare(
      'SELECT slug, COUNT(*) AS open_notes FROM galley_notes ' +
        'WHERE closed_at IS NULL GROUP BY slug',
    )
    .all();
  return new Map(results.map((row) => [row.slug, Number(row.open_notes)]));
}
