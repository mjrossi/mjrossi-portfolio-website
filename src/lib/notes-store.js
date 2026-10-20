// The only file that knows the columns of galley_notes. Same arrangement as
// links-store.js.
//
// /api/galley's INSERT and reads stay in the endpoint: the write quota and the
// read ceilings are endpoint policy, not table access.
//
// A note is open while `closed_at IS NULL` (migrations/0003 dropped `status`).

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

function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}

// ── writes ───────────────────────────────────────────

/**
 * Close notes. Scoped to the slug as well as the ids, so an id from another post
 * does nothing; already-closed rows keep their date.
 *
 * Returns the ids it closed. Every no-op is silent by construction, so the
 * caller says which happened.
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
 * Re-open one closed note: the undo for a mistaken close. One at a time, never
 * bulk — the correction should make you name what you mean.
 *
 * As with revokeLinks, the slug clause is tautological at the CLI; the
 * wrong-post check is scripts/resolve-id.mjs.
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
 * Move every note to a new slug: the database half of a post rename. Without
 * it the review history detaches with nothing saying why.
 *
 * Links are revoked by a rename, not moved, because their slug is inside the
 * signed token. Notes have no such tie.
 *
 * Unscoped by state: closed notes move closed, on their original dates. Returns
 * the open/closed split. Idempotent, which is the repair for an interrupted
 * `just post-rename` (it spans two wrangler calls and can't be atomic).
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} from
 * @param {string} to
 * @returns {Promise<{ open: number, closed: number }>} notes this call moved
 */
export async function renameNotes(store, from, to) {
  checkSlug(from, 'from slug');
  checkSlug(to, 'to slug');
  if (from === to) {
    throw new Error(`notes-store: renameNotes was given the same slug twice (${from})`);
  }
  const { results } = await store
    .prepare('UPDATE galley_notes SET slug = ? WHERE slug = ? RETURNING closed_at')
    .bind(to, from)
    .all();
  let open = 0;
  let closed = 0;
  for (const row of results) {
    if (row.closed_at === null || row.closed_at === undefined) open += 1;
    else closed += 1;
  }
  return { open, closed };
}

/**
 * Insert notes directly. A TEST FIXTURE, for states the endpoint can't reach on
 * demand (an older revision, already closed). The local-only guard is in
 * scripts/notes-db.mjs; see clearLinks.
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
 * Delete every note for the named posts. DESTRUCTIVE; smoke's fixture reset.
 * `reviewer` narrows it so a shared local database keeps notes left by hand.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string[]} slugs
 * @param {{ reviewer?: string | null }} [scope]
 */
export async function clearNotes(store, slugs, { reviewer = null } = {}) {
  // `IN ()` is a syntax error, not a no-op.
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

const COLUMNS =
  'id, revision_hash, reviewer, kind, src_start, src_end, ' +
  'quote, prefix, suffix, body, suggestion, created_at, closed_at';

/**
 * One note by id, open or closed, with its slug — so galley-close and
 * galley-reopen can be given an id alone.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getNoteById(store, id) {
  checkNoteId(id);
  return store
    .prepare(`SELECT slug, ${COLUMNS} FROM galley_notes WHERE id = ?`)
    .bind(id)
    .first();
}

/**
 * Notes for one post, oldest first. Open only unless `includeClosed`
 * (`just galley <slug> --all`).
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
 * Open notes per post in one round-trip, for the Desk index (one listNotes per
 * draft would grow with the collection).
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
