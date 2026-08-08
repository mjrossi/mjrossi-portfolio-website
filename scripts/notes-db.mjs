// The only file that knows the columns of galley_notes.
//
// Same shape and same argument as scripts/links-db.mjs one table over: three
// callers touch the notes -- galley-pull.mjs reads them, galley-close.mjs and
// galley-reopen.mjs move `closed_at`, and smoke.mjs seeds and clears fixtures --
// and spreading one table's SQL across them would mean restating the column list
// and the "this interpolation is safe" argument once per script. Here that
// argument is made once and ENFORCED: every value reaching a statement below has
// been shape-checked in this file, so no caller can weaken it by forgetting.
//
// The WORKER does not use this module. src/pages/api/galley.ts reaches D1
// through its binding with bound parameters, which is a different mechanism with
// different safety properties; this file exists because wrangler's `--command`
// takes a string and has no parameters at all.
//
// A note is OPEN while `closed_at IS NULL` and closed once it holds a timestamp.
// There is no 'open' value to write -- see migrations/0003, which dropped the
// `status` column this used to pretend to use.

import { readFileSync } from 'node:fs';
import { NOTE_ID_RE, noteIdsInMarkdown } from '../src/lib/galley-manifest.js';
import { SLUG_RE } from '../src/lib/preview.js';
import { d1Exec, d1Query } from './d1.mjs';

// Re-exported so galley-close.mjs and galley-reopen.mjs can validate a --note
// argument without reaching past this module, which owns everything else about
// a note id. One definition, in src/lib/galley-manifest.js, where `node --test`
// can reach it — same arrangement as SLUG_RE above.
export { NOTE_ID_RE };

// ── input validation ─────────────────────────────────
//
// SLUG_RE and NOTE_ID_RE admit no quotes, spaces, or backslashes, which is what
// makes interpolating these values into SQL safe. wrangler's `--command` takes a
// string rather than bound parameters, so this is the boundary that has to hold;
// it is checked here rather than trusted from the caller.

function checkSlug(slug, label = 'slug') {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(`notes-db: invalid ${label} ${JSON.stringify(slug)}`);
  }
  return slug;
}

function checkNoteId(id) {
  if (typeof id !== 'string' || !NOTE_ID_RE.test(id)) {
    throw new Error(`notes-db: invalid note id ${JSON.stringify(id)}`);
  }
  return id;
}

function checkInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`notes-db: ${label} must be an integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** SQL literal for a nullable text field. */
function textLiteral(value, label) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value !== 'string') {
    throw new Error(`notes-db: ${label} must be a string or null`);
  }
  // Doubling is SQLite's own escape, and it is the only transformation applied:
  // reviewer prose is arbitrary text and must survive verbatim into the row.
  return `'${value.replace(/'/g, "''")}'`;
}

// ── the id scan ──────────────────────────────────────

/**
 * Every note id mentioned in a pulled review file, in order, deduplicated.
 *
 * THIS IS WHAT SCOPES A CLOSE. `just galley-close` closes the notes the author
 * actually pulled and worked through, not "every note that looks old" -- because
 * with two reviewers those are different sets, and the second one silently
 * includes feedback nobody has read yet. docs/galley/<slug>.md is the record of
 * what was in front of the author, it is committed alongside the revision that
 * answers it, and it is therefore the honest answer to "which notes did I deal
 * with?".
 *
 * The scan itself is src/lib/galley-manifest.js, which is where the rules about
 * what counts as a listed id live -- it reads only the meta lines galley-pull.mjs
 * writes, so an id appearing in a reviewer's own prose cannot name another
 * reviewer's note for closure. This wrapper is the file read and nothing else,
 * which is what lets the interesting half be unit-tested.
 *
 * @param {string} path
 * @returns {string[]}
 */
export function noteIdsInFile(path) {
  return noteIdsInMarkdown(readFileSync(path, 'utf8'));
}

// ── writes ───────────────────────────────────────────

/**
 * Close notes: mark a round finished with.
 *
 * ALWAYS scoped to the slug as well as the ids, like every write in links-db.mjs:
 * an id belonging to another post does nothing rather than quietly closing a note
 * on a draft the operator did not name.
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
 * @param {string} slug
 * @param {string[]} ids
 * @param {{ local?: boolean }} [opts]
 * @returns {string[]} ids this call closed
 */
export function closeNotes(slug, ids, { local = false } = {}) {
  checkSlug(slug);
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const list = ids.map((id) => `'${checkNoteId(id)}'`).join(', ');
  const rows = d1Query(
    `UPDATE galley_notes SET closed_at = ${Date.now()} ` +
      `WHERE slug = '${slug}' AND id IN (${list}) AND closed_at IS NULL ` +
      'RETURNING id',
    { local },
  );
  return rows.map((row) => row.id);
}

/**
 * Re-open one closed note. The undo for a mistaken close.
 *
 * Deliberately one note at a time and never bulk: closing is the routine act and
 * re-opening is the correction, so the correction should be the one that makes
 * you name what you mean. Same reasoning as revoking staying per-post while the
 * roster reads across all of them.
 *
 * @param {string} slug
 * @param {string} id
 * @param {{ local?: boolean }} [opts]
 * @returns {boolean} whether a row changed
 */
export function reopenNote(slug, id, { local = false } = {}) {
  checkSlug(slug);
  checkNoteId(id);
  const rows = d1Query(
    'UPDATE galley_notes SET closed_at = NULL ' +
      `WHERE slug = '${slug}' AND id = '${id}' AND closed_at IS NOT NULL ` +
      'RETURNING id',
    { local },
  );
  return rows.length > 0;
}

/**
 * Insert notes directly. LOCAL ONLY, and a test fixture.
 *
 * Production notes are written by src/pages/api/galley.ts through the D1 binding,
 * behind a signed review link and a write quota. This exists so smoke can seed
 * the states that endpoint cannot reach on demand -- a note against an older
 * revision, a note already closed -- and it refuses to run against production
 * because nothing else in this feature writes a note from the CLI.
 *
 * @param {{ id: string, slug: string, revisionHash: string, reviewer: string,
 *           kind?: string, srcStart?: number | null, srcEnd?: number | null,
 *           quote?: string | null, prefix?: string | null, suffix?: string | null,
 *           body?: string | null, suggestion?: string | null,
 *           createdAt?: number, closedAt?: number | null }[]} rows
 * @param {{ local?: boolean }} [opts]
 */
export function seedNotes(rows, { local = false } = {}) {
  if (!local) {
    throw new Error('notes-db: seedNotes is local-only — real notes come from /api/galley');
  }
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('notes-db: seedNotes needs at least one row');
  }
  const now = Date.now();
  const values = rows.map((row) => {
    const kind = row.kind ?? 'comment';
    if (kind !== 'comment' && kind !== 'suggestion') {
      throw new Error(`notes-db: invalid kind ${JSON.stringify(kind)}`);
    }
    const nullableInt = (value, label) =>
      value === null || value === undefined ? 'NULL' : checkInteger(value, label);
    return (
      `('${checkNoteId(row.id)}', '${checkSlug(row.slug)}', ` +
      `${textLiteral(row.revisionHash, 'revisionHash')}, ` +
      `${textLiteral(row.reviewer, 'reviewer')}, '${kind}', ` +
      `${nullableInt(row.srcStart, 'srcStart')}, ${nullableInt(row.srcEnd, 'srcEnd')}, ` +
      `${textLiteral(row.quote ?? null, 'quote')}, ${textLiteral(row.prefix ?? null, 'prefix')}, ` +
      `${textLiteral(row.suffix ?? null, 'suffix')}, ${textLiteral(row.body ?? null, 'body')}, ` +
      `${textLiteral(row.suggestion ?? null, 'suggestion')}, ` +
      `${checkInteger(row.createdAt ?? now, 'createdAt')}, ` +
      `${nullableInt(row.closedAt ?? null, 'closedAt')})`
    );
  });
  d1Exec(
    'INSERT INTO galley_notes (id, slug, revision_hash, reviewer, kind, src_start, src_end, ' +
      'quote, prefix, suffix, body, suggestion, created_at, closed_at) VALUES ' +
      values.join(', '),
    { local: true },
  );
}

/**
 * Delete every note for the named posts. LOCAL ONLY.
 *
 * A test-fixture helper, like clearLinks: scripts/smoke.mjs resets its rows
 * before each run. Refuses to run against production, because nothing in this
 * feature deletes a note -- closing is how a note stops mattering, and it keeps
 * the row.
 *
 * `reviewer` narrows it further, so a smoke run on a shared local database
 * clears only what it wrote and leaves a real note left there by hand alone.
 *
 * @param {string[]} slugs
 * @param {{ reviewer?: string | null }} [scope]
 * @param {{ local?: boolean }} [opts]
 */
export function clearNotes(slugs, { reviewer = null } = {}, { local = false } = {}) {
  if (!local) {
    throw new Error('notes-db: clearNotes is local-only — closing is how a real note is retired');
  }
  // Guarded like closeNotes above: an empty list would interpolate to
  // `WHERE slug IN ()`, which is a syntax error rather than a no-op. Safe today
  // only because the caller passes a constant.
  if (!Array.isArray(slugs) || slugs.length === 0) return;
  const list = slugs.map((slug) => `'${checkSlug(slug)}'`).join(', ');
  const scope = reviewer === null ? '' : ` AND reviewer = ${textLiteral(reviewer, 'reviewer')}`;
  d1Exec(`DELETE FROM galley_notes WHERE slug IN (${list})${scope}`, { local: true });
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
 * @param {string} slug
 * @param {{ includeClosed?: boolean }} [scope]
 * @param {{ local?: boolean }} [opts]
 * @returns {Record<string, unknown>[]}
 */
export function listNotes(slug, { includeClosed = false } = {}, { local = false } = {}) {
  checkSlug(slug);
  const scope = includeClosed ? '' : ' AND closed_at IS NULL';
  return d1Query(
    `SELECT ${COLUMNS} FROM galley_notes WHERE slug = '${slug}'${scope} ORDER BY created_at ASC`,
    { local },
  );
}
