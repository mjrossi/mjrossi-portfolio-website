// End a review round: mark the notes you pulled and applied as closed.
//
//   just galley-close my-draft --remote                    # the whole pulled round
//   just galley-close my-draft --remote --note <id>        # one note
//   just galley-close my-draft --remote --from path/to.md  # a pull written elsewhere
//
// --remote or --local is REQUIRED; see scripts/database-target.mjs. Closing the
// wrong database reports success while the reviewer's margin goes on showing
// every note you just applied.
//
// WHY THIS READS A FILE INSTEAD OF SELECTING ON DRIFT.
//
// The obvious rule -- "close every note written against a revision I have since
// replaced" -- is wrong the moment a second reviewer exists. Drift is a property
// of the FILE, not of whether anyone has read the note: if r1 finishes, you apply
// their round and merge, every note r2 has filed in the meantime drifts too, and
// a drift-based close would retire feedback nobody has looked at. Silently, and
// with the reviewer's margin then showing it as addressed.
//
// docs/galley/<slug>.md is the honest answer to "which notes did I deal with?".
// It is exactly what the author had in front of them, it is committed alongside
// the revision that answers it, and notes filed after that pull are structurally
// out of reach. An id the scan misses stays open, which is the direction that
// loses nothing.
//
// RUN IT AFTER THE REVISION MERGES, not before. Closing first would retire notes
// whose fixes are not in the file yet.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { galleyFile } from '../src/lib/galley-manifest.js';
import { SLUG_RE } from '../src/lib/preview.js';
import { cli, relativeToCwd } from './cli.mjs';
import { databaseFlag, databaseLabel } from './database-target.mjs';
import { NOTE_ID_RE, closeNotes, listNotes, noteIdsInFile } from './notes-db.mjs';

const { die, resolveDatabase, requirePost } = cli('galley-close');

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
let slug = null;
let local = false;
let remote = false;
let noteId = null;
let from = null;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--local') {
    local = true;
  } else if (arg === '--remote') {
    remote = true;
  } else if (arg === '--note') {
    noteId = argv[++i];
    if (!noteId) die('--note requires a note id');
  } else if (arg === '--from') {
    from = argv[++i];
    if (!from) die('--from requires a path');
  } else if (arg.startsWith('-')) {
    die(`unknown flag ${arg}`);
  } else if (slug === null) {
    slug = arg;
  } else {
    die(`unexpected argument ${arg}`);
  }
}

if (!slug) {
  die('usage: just galley-close <slug> (--remote | --local) [--note ID] [--from PATH]');
}
if (!SLUG_RE.test(slug)) die(`invalid slug ${JSON.stringify(slug)}`);
if (noteId !== null && !NOTE_ID_RE.test(noteId)) {
  die(`invalid note id ${JSON.stringify(noteId)} — ids are printed in the pulled review file`);
}
if (noteId !== null && from !== null) die('--note and --from are alternatives; pass one');

const useLocal = resolveDatabase({ local, remote });

// Validated against real content for the same reason preview-link.mjs does it: a
// typo would otherwise report "no notes to close" for a post that has plenty,
// which reads exactly like the round already being closed.
requirePost(slug);

const where = databaseLabel(useLocal);
const flag = databaseFlag(useLocal);

// ── which notes ──────────────────────────────────────

// `manifest` is BOTH the file read and the mode: null means --note, i.e. one
// named note and no round. Everything below discriminates on it alone, so the
// two can never be asked separately and answer differently.
let ids;
let manifest = null;
let shown = null;
if (noteId !== null) {
  ids = [noteId];
} else {
  manifest = resolve(from ?? galleyFile(slug));
  // What the operator would type, rather than the absolute path resolve() gave
  // us — every message below names the file.
  shown = relativeToCwd(manifest);
  if (!existsSync(manifest)) {
    die(
      `no ${shown} — pull the round first:\n` +
        `    just galley ${slug} ${flag}\n` +
        '  (or close a single note with --note <id>)',
    );
  }
  ids = noteIdsInFile(manifest);
  if (ids.length === 0) {
    die(
      `${shown} lists no note ids.\n` +
        '  Files pulled before note ids were printed have none — re-pull to refresh it.',
    );
  }
}

// ── close ────────────────────────────────────────────

let closed;
let stillOpen;
try {
  closed = closeNotes(slug, ids, { local: useLocal });
  // Read back AFTER the write, so "left open" reflects the state the operator is
  // walking away from rather than a snapshot taken before it changed.
  stillOpen = listNotes(slug, { includeClosed: false }, { local: useLocal });
} catch (err) {
  die(err.message);
}

if (manifest) {
  console.error(`galley-close: ${shown} lists ${ids.length} note(s)`);
}
console.error(`              ${closed.length} closed  (${where})`);

// Every no-op is silent in SQL -- an id from another post is scoped away, an
// already-closed one matches nothing, one that never existed matches nothing --
// so say when nothing happened rather than reporting a successful close.
if (closed.length === 0) {
  console.error(
    manifest
      ? '              nothing changed — this round was already closed'
      : '              nothing changed — that note is already closed, or belongs to another post',
  );
}

// THE LINE THIS COMMAND EXISTS FOR. Notes filed after the pull are deliberately
// untouched, and the operator has to know they are there: they are a reviewer's
// unread feedback, and nothing else will mention them until the next pull.
if (stillOpen.length > 0) {
  const byReviewer = new Map();
  for (const note of stillOpen) {
    byReviewer.set(note.reviewer, (byReviewer.get(note.reviewer) ?? 0) + 1);
  }
  const who = [...byReviewer]
    .map(([reviewer, count]) => `${reviewer} (${count})`)
    .join(', ');
  // "Filed after that pull" is only true when there WAS a pull. Everything the
  // manifest listed has just been closed, so whatever is left arrived after it —
  // that is the concurrent-reviewer signal this command exists to give. Under
  // --note there is no manifest and no round: these are simply the post's other
  // open notes, and calling them late-arriving would point the operator at a
  // reviewer who did nothing.
  console.error(
    manifest
      ? `\n              ${stillOpen.length} note(s) still open, filed after that pull — ${who}`
      : `\n              ${stillOpen.length} note(s) still open on ${slug} — ${who}`,
  );
  console.error(
    `              ${manifest ? 'pull again before closing another round:' : 'read them with:'}\n` +
      `                just galley ${slug} ${flag}\n`,
  );
} else {
  console.error('');
}

// Nothing on stdout. There is no artifact to pipe, and the pulled file is now a
// record of a finished round rather than a worklist -- same reasoning as
// preview-extend.mjs keeping stdout empty so an unchanged URL is not re-sent.

// NON-ZERO WHEN NOTHING CLOSED, on the same rule as preview-extend --all: an
// outcome the operator has to act on is not a success, and the message saying so
// went to stderr where a wrapper will not see it. "This round was already
// closed" is usually harmless and occasionally means the wrong slug, the wrong
// database, or a file that lists ids the table does not have -- and those look
// identical from here. Exiting non-zero is what stops a chained `just
// galley-close … && git commit` from recording a round that never ended.
//
// `exitCode` rather than `exit()`: everything this command says goes to stderr,
// which Node writes ASYNCHRONOUSLY when it is a pipe, and process.exit() would
// truncate exactly the explanation the operator needs. Nothing follows, so
// setting the code and falling off the end is both safe and sufficient.
if (closed.length === 0) process.exitCode = 1;
