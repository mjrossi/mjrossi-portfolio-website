// End a review round: close the notes you pulled and applied.
//
//   just galley-close <slug> --remote                 # the round in docs/galley/<slug>.md
//   just galley-close <note-id> --remote              # one note; the post comes off the row
//   just galley-close <slug> <note-id> --remote       # the same, post asserted
//   just galley-close <slug> --remote --from path.md  # a pull written elsewhere
//
// --remote or --local is REQUIRED (database-target.mjs).
//
// READS THE FILE, NOT DRIFT. "Close everything against an old revision" is wrong
// once a second reviewer exists: merging r1's round drifts r2's unread notes
// too. docs/galley/<slug>.md is exactly what the author had in front of them,
// and notes filed after that pull are out of reach. A missed id stays open.
//
// RUN IT AFTER THE REVISION MERGES, or it retires notes whose fixes aren't in yet.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { galleyFile } from '../src/lib/galley-manifest.js';
import { isoDay } from '../src/lib/galley-render.js';
import { SLUG_RE } from '../src/lib/preview.js';
import { cli, relativeToCwd } from './cli.mjs';
import { databaseFlag, databaseLabel } from './database-target.mjs';
import { NOTE_ID_RE, closeNotes, listNotes, noteIdsInFile } from './notes-db.mjs';
import { resolveNote } from './resolve-id.mjs';

const { die, resolveDatabase, requirePost } = cli('galley-close');

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
const positional = [];
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
  } else {
    positional.push(arg);
  }
}

// The first positional's shape says which (UUID vs slug); `--note` is an alias.
//
//   <note-id>            close that one note; the post comes off the row
//   <slug> <note-id>     the same, with the post asserted
//   <slug>               close the round in docs/galley/<slug>.md
let slug = null;

if (noteId === null && positional.length === 1 && NOTE_ID_RE.test(positional[0])) {
  [noteId] = positional;
} else if (noteId !== null) {
  if (positional.length > 1) die(`unexpected argument ${positional[1]}`);
  slug = positional[0] ?? null;
} else if (positional.length === 2 && NOTE_ID_RE.test(positional[1])) {
  [slug, noteId] = positional;
} else if (positional.length === 1) {
  [slug] = positional;
} else {
  die('usage: just galley-close (<slug> | <note-id>) (--remote | --local) [--from PATH]');
}

if (slug !== null && !SLUG_RE.test(slug)) die(`invalid slug ${JSON.stringify(slug)}`);
if (noteId !== null && !NOTE_ID_RE.test(noteId)) {
  die(`invalid note id ${JSON.stringify(noteId)} — ids are printed in the pulled review file`);
}
// --from names a round file; a single note has none.
if (noteId !== null && from !== null) die('--note and --from are alternatives; pass one');
const useLocal = resolveDatabase({ local, remote });

// requirePost catches a typo, which would otherwise read as "already closed".
let resolvedNote = null;
if (noteId !== null) {
  resolvedNote = await resolveNote(die, noteId, { slug, local: useLocal });
  ({ slug } = resolvedNote);
}
requirePost(slug);

const where = databaseLabel(useLocal);
const flag = databaseFlag(useLocal);

// ── which notes ──────────────────────────────────────

// `manifest` is both the file and the mode: null means one named note.
let ids;
let manifest = null;
let shown = null;
if (noteId !== null) {
  ids = [noteId];
} else {
  manifest = resolve(from ?? galleyFile(slug));
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
  closed = await closeNotes(slug, ids, { local: useLocal });
  // Read AFTER the write, so "left open" is the state being walked away from.
  stillOpen = await listNotes(slug, { includeClosed: false }, { local: useLocal });
} catch (err) {
  die(err.message);
}

if (manifest) {
  console.error(`galley-close: ${shown} lists ${ids.length} note(s)`);
} else {
  // Derived from the note, so say which post: the only sign the id went where meant.
  console.error(`galley-close: note ${noteId} on ${slug}`);
}
console.error(`              ${closed.length} closed  (${where})`);

// No-ops are silent in SQL, so say so; on the one-note path, read the date
// off the row rather than assume the cause.
if (closed.length === 0) {
  // Already closed when read. The fallback covers a close landing in between.
  const closedAt = resolvedNote?.row?.closed_at;
  console.error(
    manifest
      ? '              nothing changed — this round was already closed'
      : `              nothing changed — that note was already closed${closedAt ? ` on ${isoDay(closedAt)}` : ''}`,
  );
}

// THE LINE THIS COMMAND EXISTS FOR: notes filed after the pull are a reviewer's
// unread feedback, and nothing else will mention them.
if (stillOpen.length > 0) {
  const byReviewer = new Map();
  for (const note of stillOpen) {
    byReviewer.set(note.reviewer, (byReviewer.get(note.reviewer) ?? 0) + 1);
  }
  const who = [...byReviewer]
    .map(([reviewer, count]) => `${reviewer} (${count})`)
    .join(', ');
  // "Filed after that pull" only when there was a pull; for one note these are
  // just the post's other open notes.
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

// Nothing on stdout: no artifact to pipe.
//
// NON-ZERO WHEN NOTHING CLOSED, so `just galley-close … && git commit` can't
// record a round that never ended (the wrong slug or database looks the same).
// `exitCode`, not exit(): stderr to a pipe is async, and exit() truncates it.
if (closed.length === 0) process.exitCode = 1;
