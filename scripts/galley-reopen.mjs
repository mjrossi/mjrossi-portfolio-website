// Put one closed note back into the working set. The undo for `just galley-close`.
//
//   just galley-reopen <note-id> --remote
//   just galley-reopen my-draft <note-id> --remote   # post asserted
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
//
// THE POST IS DERIVED FROM THE NOTE. galley_notes is keyed on a randomUUID, so
// naming the post as well was redundant; a slug in front of the id is still
// accepted and is then an assertion. See scripts/resolve-id.mjs.

import { SLUG_RE } from '../src/lib/preview.js';
import { cli } from './cli.mjs';
import { databaseFlag, databaseLabel } from './database-target.mjs';
import { reopenNote } from './notes-db.mjs';
import { resolveNote } from './resolve-id.mjs';

const { die, resolveDatabase, requirePost } = cli('galley-reopen');

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
const positional = [];
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
    // Kept as an alias for the positional. It was only ever a flag because the
    // slug held the first positional slot, and that slot is free now.
    noteId = argv[++i];
    if (!noteId) die('--note requires a note id');
  } else if (arg.startsWith('-')) {
    die(`unknown flag ${arg}`);
  } else {
    positional.push(arg);
  }
}

// One positional is the note; two are <slug> <note>, with the slug asserted.
// A --note flag fills the id, leaving at most a slug in front of it.
let slug = null;
if (noteId !== null) {
  if (positional.length > 1) die(`unexpected argument ${positional[1]}`);
  slug = positional[0] ?? null;
} else if (positional.length === 1) {
  [noteId] = positional;
} else if (positional.length === 2) {
  [slug, noteId] = positional;
} else {
  die('usage: just galley-reopen <note-id> (--remote | --local)');
}

if (slug !== null && !SLUG_RE.test(slug)) die(`invalid slug ${JSON.stringify(slug)}`);

const useLocal = resolveDatabase({ local, remote });
const where = databaseLabel(useLocal);

// The post comes off the note. requirePost then validates it against real
// content exactly as before -- a row naming a post that no longer exists is
// worth saying out loud rather than reopening into.
let row;
({ slug, row } = await resolveNote(die, noteId, { slug, local: useLocal }));
requirePost(slug);

// ── reopen ───────────────────────────────────────────

let changed;
try {
  changed = await reopenNote(slug, noteId, { local: useLocal });
} catch (err) {
  die(err.message);
}

// A no-op now has exactly one cause. "No such note" and "wrong post" are both
// settled by resolveNote before the UPDATE runs, and the row it returned says
// which -- so this needs no second read, where it used to list every note on the
// post to find one by id.
if (!changed) {
  die(
    row.closed_at == null
      ? `note ${noteId} is already open (${where}) — nothing to do`
      : `the update matched no row for note ${noteId} (${where}), and the row itself looks closed.\n` +
          `  Re-run just galley ${slug} --all ${databaseFlag(useLocal)} to see its current state.`,
  );
}

console.error(`galley-reopen: note ${noteId} re-opened on ${slug} (${where})`);
console.error(`               it is back in \`just galley ${slug} ${databaseFlag(useLocal)}\` and in the reviewer's margin\n`);
