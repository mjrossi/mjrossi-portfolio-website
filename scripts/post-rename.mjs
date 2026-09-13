// Move a post's review history to its new slug, after the file has been renamed.
//
//   just post-rename <old-slug> <new-slug> --remote
//
// RUN IT AFTER THE `git mv`, not before. Same stance as galley-close running
// after the merge and reading the committed file back: the operator owns every
// write to the working tree, and this script's job is to prove the move happened
// and then fix what git cannot reach.
//
// WHY IT EXISTS. A post's slug is its filename, so a rename looks complete once
// the .mdx has moved and the title matches. Two tables key rows by slug and
// neither follows:
//
//   galley_notes   every note the editors left  -> orphaned, and `just galley
//                  <new>` says "no notes" for a post that has plenty
//   preview_links  every link issued            -> the slug is inside the
//                  token's HMAC, so all of them are dead, while preview-roster
//                  goes on listing them as live
//
// Nothing reports either. The site builds, smoke passes, and the review history
// quietly detaches from the post it is about.
//
// THE TWO TABLES GET OPPOSITE TREATMENT, and the reason is which of them mirrors
// something signed. `preview_links.slug` mirrors the signed payload, so moving it
// would describe a link that cannot exist -- those links are not renamed, they
// are dead, and `revoked_at` is how this schema records a dead link. A note
// mirrors nothing: it is about the post, which still exists under a new name.
//
// IT DOES NOT MINT. `just preview-link` is the only command that issues access,
// and a second one would have to be found and reasoned about every time that
// claim is checked. The re-mint lines are printed for you to run.
//
// --remote or --local is REQUIRED; see scripts/database-target.mjs. Renaming in
// the wrong database reports a tidy success while the real rows stay orphaned.

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

// The new post exists. Same guard, and the same reason, as everywhere else on
// this surface: a typo here would move every note to a slug no post will ever
// have, and the next pull would report an empty round rather than an error.
requirePost(to);

// And the old one is gone. This is what makes the command a RENAME rather than a
// copy -- without it, `just post-rename <a> <b>` run against two posts that both
// exist would strip one of its history and say nothing. It is also the only
// check that can catch the operator renaming the wrong direction.
if (resolvePostSource(from)) {
  die(
    `${from} still has a source file — run this after the git mv, not before.\n` +
      '  Both slugs naming a post means this would move one post’s notes onto another.',
  );
}

// The pulled review file is committed under the old slug and nothing can refresh
// it there: galley-pull needs a post to resolve, and that slug no longer names
// one. Requiring the move here puts it in the same commit as the .mdx, and forces
// whatever the old file's header claims about an unfinished round to be re-read.
const oldGalley = galleyFile(from);
if (existsSync(oldGalley)) {
  die(
    `${oldGalley} is still there.\n` +
      `    git mv ${oldGalley} ${galleyFile(to)}\n` +
      '  Nothing can re-pull that file under the old slug, so it would sit there\n' +
      '  reading like an open round forever.',
  );
}

// Slugs are frozen at publication: a live post's URL is public, and this repo has
// no post-level redirect (RETIRED in src/lib/tags.js covers tags only). Refusing
// here is what makes "pre-publication only" a property rather than a docs line.
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

// TWO POPULATED SLUGS IS A MERGE, not a rename, and the two histories would
// interleave by created_at with nothing afterwards able to tell them apart.
//
// The condition is both-populated rather than "the destination has notes",
// which is the obvious rule and is wrong: after the notes move, the destination
// always has them. A run interrupted before the links are revoked would then be
// unrepeatable -- and repeating it is the only repair there is, because the two
// writes are two wrangler invocations and cannot share a transaction.
if (arriving.length > 0 && departing.length > 0) {
  die(
    `both slugs have notes (${from}: ${departing.length}, ${to}: ${arriving.length}).\n` +
      '  That is a merge of two review histories, not a rename, and nothing\n' +
      '  downstream could separate them again. Resolve it by hand.',
  );
}

// ── move the notes, then kill the links ──────────────
//
// Notes first, deliberately. It is the write that cannot be reconstructed from
// anywhere else -- a revoked link can be re-minted, an orphaned note cannot be
// found again once nothing knows which post it belongs to.

let moved;
let revoked;
let deadLinks;
try {
  moved = await renameNotes(from, to, { local: useLocal });
  // Read the roster BEFORE revoking, so the re-mint lines below can name the
  // reviewers whose access this is about to withdraw.
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

// WHO LOST ACCESS. A revoked link was already dead — the slug is signed into the
// token, so it stopped opening anything the moment the file moved — but the
// reviewer holding it does not know that, and nothing else will tell them.
if (revoked.length > 0) {
  const byId = new Map(deadLinks.map((row) => [row.id, row]));
  // Reviewers who already hold a live link under the new slug: printing a mint
  // line for them would issue a second link to someone who can already read the
  // draft, and leave the roster carrying an entry nobody recognises.
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

// Nothing on stdout. The re-mint lines are commands to read and decide about --
// a review round may well be over -- rather than an artifact to pipe, and a URL
// is not produced here at all. Same reasoning as galley-close.
//
// NON-ZERO WHEN NOTHING CHANGED, on galley-close's rule: "already done" and
// "wrong slug, or wrong database" look identical from here, and only one of them
// is a success. This is what stops a chained `just post-rename … && git commit`
// from recording a rename that never reached the table.
if (moved.open + moved.closed === 0 && revoked.length === 0) process.exitCode = 1;
