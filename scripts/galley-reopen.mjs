// Put one closed note back into the working set. The undo for `just galley-close`.
//
//   just galley-reopen my-draft --note <id> --remote
//
// --remote or --local is REQUIRED; see scripts/database-target.mjs.
//
// ONE NOTE AT A TIME, never bulk, and that asymmetry is deliberate. Closing is
// the routine act at the end of every round, so it takes a whole file's worth of
// ids. Re-opening is a correction, and a correction should make you name exactly
// what you meant -- the same reasoning that keeps `just preview-revoke` scoped to
// one post while the roster reads across all of them.
//
// Ids come from the pulled review file: `just galley <slug> --all` prints closed
// notes with theirs. Without this command a mistaken close would be recoverable
// only by hand-written SQL against a table nothing else in this repo updates.

import { SLUG_RE } from '../src/lib/preview.js';
import { cli } from './cli.mjs';
import { databaseFlag, databaseLabel } from './database-target.mjs';
import { NOTE_ID_RE, listNotes, reopenNote } from './notes-db.mjs';

const { die, resolveDatabase, requirePost } = cli('galley-reopen');

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
let slug = null;
let local = false;
let remote = false;
let noteId = null;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--local') {
    local = true;
  } else if (arg === '--remote') {
    remote = true;
  } else if (arg === '--note') {
    noteId = argv[++i];
    if (!noteId) die('--note requires a note id');
  } else if (arg.startsWith('-')) {
    die(`unknown flag ${arg}`);
  } else if (slug === null) {
    slug = arg;
  } else {
    die(`unexpected argument ${arg}`);
  }
}

if (!slug) die('usage: just galley-reopen <slug> --note <id> (--remote | --local)');
if (!SLUG_RE.test(slug)) die(`invalid slug ${JSON.stringify(slug)}`);
if (noteId === null) die('--note <id> is required — ids are printed by `just galley <slug> --all`');
if (!NOTE_ID_RE.test(noteId)) die(`invalid note id ${JSON.stringify(noteId)}`);

const useLocal = resolveDatabase({ local, remote });

requirePost(slug);

// ── reopen ───────────────────────────────────────────

let changed;
try {
  changed = reopenNote(slug, noteId, { local: useLocal });
} catch (err) {
  die(err.message);
}

const where = databaseLabel(useLocal);

// A no-op has three causes that look identical in SQL, so read the row back to
// say which. Same approach as preview-extend.mjs explaining its refusals: the
// operator ran this because something was wrong, and "nothing happened" is not
// an answer they can act on.
if (!changed) {
  let all;
  try {
    all = listNotes(slug, { includeClosed: true }, { local: useLocal });
  } catch (err) {
    die(err.message);
  }
  const row = all.find((note) => note.id === noteId);
  if (!row) {
    die(`no note ${noteId} on ${slug} (${where}) — check the id, and the database`);
  }
  die(`note ${noteId} is already open (${where}) — nothing to do`);
}

console.error(`galley-reopen: note ${noteId} re-opened on ${slug} (${where})`);
console.error(`               it is back in \`just galley ${slug} ${databaseFlag(useLocal)}\` and in the reviewer's margin\n`);
