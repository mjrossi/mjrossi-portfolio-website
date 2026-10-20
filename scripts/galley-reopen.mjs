// Put one closed note back into the working set: the undo for galley-close.
//
//   just galley-reopen <note-id> --remote
//   just galley-reopen my-draft <note-id> --remote   # post asserted
//
// --remote or --local is REQUIRED (database-target.mjs).
//
// ONE NOTE AT A TIME: closing is routine, re-opening a correction, and a
// correction should make you name what you mean. Ids come from
// `just galley <slug> --all`. The post comes off the note's row.

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
    // An alias for the positional.
    noteId = argv[++i];
    if (!noteId) die('--note requires a note id');
  } else if (arg.startsWith('-')) {
    die(`unknown flag ${arg}`);
  } else {
    positional.push(arg);
  }
}

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

// A row naming a post that no longer exists is said out loud, not reopened.
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

// One cause left for a no-op; resolveNote settled the others.
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
