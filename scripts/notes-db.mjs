// galley_notes for the operator CLI: binds `{ local }` to a store. The SQL is
// src/lib/notes-store.js. The local-only fixture guards live here, because only
// the CLI knows which database it was pointed at.

import { readFileSync } from 'node:fs';
import { NOTE_ID_RE, noteIdsInMarkdown } from '../src/lib/galley-manifest.js';
import * as store from '../src/lib/notes-store.js';
import { wranglerStore } from './d1-store.mjs';

// Re-exported for --note validation; defined in galley-manifest.js.
export { NOTE_ID_RE };

/** The store for one database target. */
function at(local) {
  return wranglerStore({ local });
}

// ── the id scan ──────────────────────────────────────

/**
 * Every note id a pulled review file lists: what scopes a close. The scan is
 * galley-manifest.js; this is only the file read.
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
 * Move a post's notes to a new slug. NOT local-only: a rename in production has
 * its notes there. The guard that matters (did the file move?) is in
 * post-rename.mjs.
 *
 * @see src/lib/notes-store.js
 */
export function renameNotes(from, to, { local = false } = {}) {
  return store.renameNotes(at(local), from, to);
}

/**
 * Insert notes directly. LOCAL ONLY; a test fixture. Async so the refusal
 * rejects (see clearLinks in links-db.mjs).
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
 * Delete every note for the named posts. LOCAL ONLY. Async so the refusal
 * rejects.
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
export function getNoteById(id, { local = false } = {}) {
  return store.getNoteById(at(local), id);
}

/** @see src/lib/notes-store.js */
export function listNotes(slug, scope = {}, { local = false } = {}) {
  return store.listNotes(at(local), slug, scope);
}
