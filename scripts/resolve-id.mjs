// Turn an id into its row and the post that row belongs to, so commands can
// take an id alone (`just preview-revoke <id>`). Both tables are keyed on id;
// the slug is just a column.
//
// WHERE THE CROSS-POST CHECK LIVES. Once the slug is derived from the row, the
// stores' `WHERE slug = ? AND id = ?` can only match. What protects a mistyped
// id is the mismatch check below: name a post the row disagrees with, and this
// refuses and names both. (The clause stays; it is the stores' contract.)
//
// Rows resolve in ANY state, so callers can refuse with "was revoked on …"
// rather than "no such link". Not in cli.mjs, which stays DB-free. `fetch` is a
// test seam, so the cross-post check is under `npm test`.

import { LINK_ID_RE } from '../src/lib/preview.js';
import { NOTE_ID_RE } from '../src/lib/galley-manifest.js';
import { databaseFlag, databaseLabel } from './database-target.mjs';
import { getLinkById } from './links-db.mjs';
import { getNoteById } from './notes-db.mjs';

/**
 * The shared body. One shape, two tables.
 *
 * @param {object} spec
 * @param {(message: string) => never} spec.die the calling tool's own die
 * @param {string} spec.id
 * @param {string | null} spec.slug the asserting slug, or null
 * @param {boolean} spec.local
 * @param {RegExp} spec.shape
 * @param {string} spec.shapeHint how to get a valid id, named for this table
 * @param {string} spec.noun 'link' or 'note'
 * @param {string} spec.missingHint the command that lists them, with <target> for the flag
 * @param {(id: string, opts: { local: boolean }) => Promise<Record<string, unknown> | null>} spec.fetch
 * @returns {Promise<{ id: string, slug: string, row: Record<string, unknown> }>}
 */
async function resolve({ die, id, slug, local, shape, shapeHint, noun, missingHint, fetch }) {
  if (typeof id !== 'string' || !shape.test(id)) {
    return die(`invalid ${noun} id ${JSON.stringify(id)} — ${shapeHint}`);
  }

  const where = databaseLabel(local);
  let row;
  try {
    row = await fetch(id, { local });
  } catch (err) {
    return die(err.message);
  }

  if (!row) {
    return die(
      `no ${noun} ${id} in the ${where} database.\n` +
        `  ${missingHint.replace('<target>', databaseFlag(local))}\n` +
        '  Check the database too — a row written with --local is invisible to --remote, and back.',
    );
  }

  // Named a post AND an id that disagree: refuse rather than prefer either.
  if (slug !== null && slug !== row.slug) {
    return die(
      `${noun} ${id} belongs to ${row.slug}, not ${slug} (${where}).\n` +
        `  Drop the slug to act on ${row.slug}, or check the id.`,
    );
  }

  return { id, slug: row.slug, row };
}

/**
 * A preview link, by id.
 *
 * @param {(message: string) => never} die
 * @param {string} id
 * @param {{ slug?: string | null, local?: boolean, fetch?: typeof getLinkById }} [opts]
 * @returns {Promise<{ id: string, slug: string, row: Record<string, unknown> }>}
 */
export function resolveLink(die, id, { slug = null, local = false, fetch = getLinkById } = {}) {
  return resolve({
    die,
    id,
    slug,
    local,
    shape: LINK_ID_RE,
    shapeHint:
      'ids are 16 lowercase hex characters, as printed by `just preview-link` ' +
      'and listed by `just preview-roster`.',
    noun: 'link',
    missingHint: 'just preview-roster <target> lists every link across every post.',
    fetch,
  });
}

/**
 * A galley note, by id.
 *
 * @param {(message: string) => never} die
 * @param {string} id
 * @param {{ slug?: string | null, local?: boolean, fetch?: typeof getNoteById }} [opts]
 * @returns {Promise<{ id: string, slug: string, row: Record<string, unknown> }>}
 */
export function resolveNote(die, id, { slug = null, local = false, fetch = getNoteById } = {}) {
  return resolve({
    die,
    id,
    slug,
    local,
    shape: NOTE_ID_RE,
    shapeHint:
      'ids are UUIDs, printed in the pulled review file and by `just galley <slug> --all`.',
    noun: 'note',
    missingHint: 'just galley <slug> --all <target> lists every note on a post, closed ones included.',
    fetch,
  });
}
