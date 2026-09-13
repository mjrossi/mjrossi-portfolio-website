// Turn an id into the row it names, and the post that row belongs to.
//
// THE SLUG WAS NEVER IDENTIFYING. Both tables are keyed on `id TEXT PRIMARY KEY`
// with `slug` as an ordinary column, so every command that already has an id has
// the post too -- it just had to be told. This is the lookup that stops it having
// to be told: `just preview-revoke <id>` instead of `just preview-revoke <slug>
// <id>`, and the same for extend, reopen and close.
//
// WHERE THE CROSS-POST INVARIANT LIVES NOW. The store statements still say
// `WHERE slug = ? AND id = ?`, but once the slug is DERIVED from the row it is
// then used to filter, that clause is tautological -- it can only match. What
// actually protects a mistyped id is the mismatch check below: if the operator
// names a post and the row disagrees, this refuses and names both. When no post
// is named there is nothing to disagree with, and acting on the id is what was
// asked for.
//
// The clause stays in the statements regardless. It costs nothing and it remains
// the store modules' own contract for callers that legitimately hold a slug --
// extendLinks, closeNotes, and the Desk. But it is no longer the thing to point
// at when explaining why a wrong id is safe.
//
// ROWS RESOLVE IN ANY STATE -- revoked, expired, spent, closed. The best refusals
// in this feature ("was revoked on …", "past the ceiling it was signed with …",
// "is already open") exist only because the row is found and THEN rejected.
// Filtering to live rows here would flatten every one of them into "no such link".
//
// NOT IN cli.mjs, which is deliberately DB-free: giving it a store import would
// pull the wrangler transport into every script that only wants `die`.
//
// `fetch` IS A TEST SEAM, and nothing else -- the same arrangement, and the same
// reasoning, as `exec` in scripts/d1-store.mjs and the duck-typed store
// src/lib/preview-links.js takes. Every refusal below is decided from { id, slug,
// row } and needs no database to reach; without a seam the only way to exercise
// the one that matters would be a migrated D1 and a wrangler subprocess per case,
// which puts the cross-post invariant behind `npm run build && npm run smoke`
// rather than behind `npm test`. See src/lib/resolve-id.test.js.

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

  // The operator named a post AND an id, and they disagree. Refuse rather than
  // silently preferring either: preferring the row would act on a draft they did
  // not name, and preferring the slug would find nothing and report the id as
  // missing when it plainly exists.
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
