// The database half of a post rename. Run it AFTER the `git mv`; it checks the
// move happened, then fixes what git can't reach.
//
//   just post-rename <old-slug> <new-slug> --remote
//
// Two tables key on the slug and neither follows a rename, silently:
//
//   galley_notes   MOVED — a note is about the post, which still exists
//   preview_links  REVOKED — the slug is inside each token's HMAC, so they are
//                  already dead; revoked_at records that
//
// It does not mint: preview-link is the only command that issues access. The
// re-mint lines are printed for you to run.
//
// --remote or --local is REQUIRED (database-target.mjs).

import { existsSync } from 'node:fs';
import { galleyFile } from '../src/lib/galley-manifest.js';
import { linkState } from '../src/lib/link-state.js';
import { SLUG_RE } from '../src/lib/preview.js';
import { isPublished } from '../src/lib/schedule.js';
import { cli } from './cli.mjs';
import { readPubDate, resolvePostSource } from './content.mjs';
import { databaseFlag, databaseLabel } from './database-target.mjs';
import { listLinks, revokeLinks } from './links-db.mjs';
import { listNotes, renameNotes } from './notes-db.mjs';

const { die, resolveDatabase, requirePost } = cli('post-rename');

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
const positional = [];
let local = false;
let remote = false;

for (const arg of argv) {
  if (arg === '--local') local = true;
  else if (arg === '--remote') remote = true;
  else if (arg.startsWith('-')) die(`unknown flag ${arg}`);
  else positional.push(arg);
}

if (positional.length !== 2) {
  die('usage: just post-rename <old-slug> <new-slug> (--remote | --local)');
}

const [from, to] = positional;
for (const [slug, label] of [[from, 'old slug'], [to, 'new slug']]) {
  if (!SLUG_RE.test(slug)) die(`invalid ${label} ${JSON.stringify(slug)}`);
}
if (from === to) die('the two slugs are the same — there is nothing to rename');

const useLocal = resolveDatabase({ local, remote });
const where = databaseLabel(useLocal);
const flag = databaseFlag(useLocal);

// ── the working tree has to agree ────────────────────

// The new post exists, or every note moves to a slug nothing will ever have.
requirePost(to);

// And the old one is gone: a RENAME, not a copy. Also catches the wrong direction.
if (resolvePostSource(from)) {
  die(
    `${from} still has a source file — run this after the git mv, not before.\n` +
      '  Both slugs naming a post means this would move one post’s notes onto another.',
  );
}

// The pulled review file can't be refreshed under a slug with no post, so it
// moves in the same commit.
const oldGalley = galleyFile(from);
if (existsSync(oldGalley)) {
  die(
    `${oldGalley} is still there.\n` +
      `    git mv ${oldGalley} ${galleyFile(to)}\n` +
      '  Nothing can re-pull that file under the old slug, so it would sit there\n' +
      '  reading like an open round forever.',
  );
}

// Slugs are frozen at publication: there is no post-level redirect.
const pubDate = readPubDate(to);
if (pubDate && isPublished(pubDate)) {
  die(
    `${to} is already published — a live post’s slug is frozen.\n` +
      '  Renaming it would break a public URL with nothing to redirect it,\n' +
      '  and the galley is closed on a published post anyway.',
  );
}

// ── and so does the table ────────────────────────────

let arriving;
let departing;
try {
  arriving = await listNotes(to, { includeClosed: true }, { local: useLocal });
  departing = await listNotes(from, { includeClosed: true }, { local: useLocal });
} catch (err) {
  die(err.message);
}

// TWO POPULATED SLUGS IS A MERGE, not a rename: the histories would interleave
// for good. Both-populated, not "destination has notes" — after a partial run
// the destination always does, and re-running is the only repair (two wrangler
// calls, no shared transaction).
if (arriving.length > 0 && departing.length > 0) {
  die(
    `both slugs have notes (${from}: ${departing.length}, ${to}: ${arriving.length}).\n` +
      '  That is a merge of two review histories, not a rename, and nothing\n' +
      '  downstream could separate them again. Resolve it by hand.',
  );
}

// ── move the notes, then kill the links ──────────────
//
// Notes first: a revoked link can be re-minted; an orphaned note can't be found.

let moved;
let revoked;
let deadLinks;
try {
  moved = await renameNotes(from, to, { local: useLocal });
  // Read before revoking, so the re-mint lines can name the reviewers.
  deadLinks = await listLinks(from, { local: useLocal });
  revoked = await revokeLinks(from, {}, { local: useLocal });
} catch (err) {
  die(err.message);
}

// ── say what happened ────────────────────────────────

console.error(`post-rename: ${from} → ${to}  (${where})`);
console.error(
  `             ${moved.open + moved.closed} note(s) moved — ` +
    `${moved.open} open, ${moved.closed} closed`,
);
console.error(`             ${revoked.length} link(s) revoked`);

if (moved.open + moved.closed === 0 && revoked.length === 0) {
  console.error(
    '\n             nothing changed — either this rename is already done, or\n' +
      `             ${from} never had notes or links in the ${where} database.`,
  );
}

// WHO LOST ACCESS: their links died with the move, and nothing else tells them.
if (revoked.length > 0) {
  const byId = new Map(deadLinks.map((row) => [row.id, row]));
  // Already re-minted on the new slug: skip, or they'd get a second link.
  const covered = new Set(
    (await listLinks(to, { local: useLocal }))
      .filter((row) => linkState(row, { pubDate }).live)
      .map((row) => row.reviewer),
  );

  const lines = [];
  for (const id of revoked) {
    const reviewer = byId.get(id)?.reviewer ?? null;
    const who = reviewer ?? '(view-only)';
    if (covered.has(reviewer)) {
      console.error(`\n             ${id}  ${who} — already holds a live link on ${to}`);
      continue;
    }
    console.error(`\n             ${id}  ${who}`);
    lines.push(
      `                just preview-link ${to}` +
        `${reviewer ? ` --reviewer ${reviewer}` : ''} ${flag}`,
    );
  }

  if (lines.length > 0) {
    console.error('\n             re-mint and re-send, if the round is still running:');
    for (const line of lines) console.error(line);
  }
  console.error('');
} else {
  console.error('');
}

// Nothing on stdout: the re-mint lines are for reading, not piping.
//
// NON-ZERO WHEN NOTHING CHANGED, on galley-close's rule, so a chained
// `&& git commit` can't record a rename that never reached the table.
if (moved.open + moved.closed === 0 && revoked.length === 0) process.exitCode = 1;
