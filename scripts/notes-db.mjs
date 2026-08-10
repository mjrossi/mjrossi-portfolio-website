// galley_notes, for the operator CLI.
//
// Same shape and same argument as scripts/links-db.mjs one table over: the
// statements live in src/lib/notes-store.js, where the worker reaches them too,
// and this file binds `{ local }` to a store so every call site keeps the shape
// it has always had.
//
// The two local-only fixture helpers keep their guards here, because `--local`
// is a fact about which DATABASE a command was pointed at and the store module
// has no concept of production.
//
// noteIdsInFile also stays: it is a file read, not a query, and it is the only
// thing in this file that touches neither D1 nor the store.

import { readFileSync } from 'node:fs';
import { NOTE_ID_RE, noteIdsInMarkdown } from '../src/lib/galley-manifest.js';
import * as store from '../src/lib/notes-store.js';
import { wranglerStore } from './d1-store.mjs';

// Re-exported so galley-close.mjs and galley-reopen.mjs can validate a --note
// argument without reaching past this module, which owns everything else about
// a note id. One definition, in src/lib/galley-manifest.js, where `node --test`
// can reach it.
export { NOTE_ID_RE };

/** The store for one database target. */
function at(local) {
  return wranglerStore({ local });
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

/** @see src/lib/notes-store.js */
export function closeNotes(slug, ids, { local = false } = {}) {
  return store.closeNotes(at(local), slug, ids);
}

/** @see src/lib/notes-store.js */
export function reopenNote(slug, id, { local = false } = {}) {
  return store.reopenNote(at(local), slug, id);
}

/**
 * Insert notes directly. LOCAL ONLY, and a test fixture.
 *
 * Production notes are written by src/pages/api/galley.ts through the D1
 * binding, behind a signed review link and a write quota. This refuses to run
 * against production because nothing else in this feature writes a note from
 * the CLI.
 *
 * `async` so the refusal rejects rather than throwing synchronously — see
 * clearLinks in scripts/links-db.mjs for why that matters.
 *
 * @see src/lib/notes-store.js
 */
export async function seedNotes(rows, { local = false } = {}) {
  if (!local) {
    throw new Error('notes-db: seedNotes is local-only — real notes come from /api/galley');
  }
  return store.seedNotes(at(true), rows);
}

/**
 * Delete every note for the named posts. LOCAL ONLY.
 *
 * Refuses to run against production, because nothing in this feature deletes a
 * note -- closing is how a real note is retired, and it keeps the row.
 *
 * `async` so the refusal rejects rather than throwing synchronously — see
 * clearLinks in scripts/links-db.mjs for why that matters.
 *
 * @see src/lib/notes-store.js
 */
export async function clearNotes(slugs, scope = {}, { local = false } = {}) {
  if (!local) {
    throw new Error('notes-db: clearNotes is local-only — closing is how a real note is retired');
  }
  return store.clearNotes(at(true), slugs, scope);
}

// ── reads ────────────────────────────────────────────

/** @see src/lib/notes-store.js */
export function listNotes(slug, scope = {}, { local = false } = {}) {
  return store.listNotes(at(local), slug, scope);
}
