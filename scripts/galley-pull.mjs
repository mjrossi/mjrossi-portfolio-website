// Pull galley notes for one post into a markdown file you can hand to Claude
// alongside the .mdx.
//
//   npm run galley -- my-draft --remote            # production notes
//   npm run galley -- my-draft --local             # the local dev database
//   npm run galley -- my-draft --remote --all      # closed rounds too
//   npm run galley -- my-draft --remote --out -    # stdout instead of docs/galley/
//
// OPEN NOTES ONLY, unless --all. A note stays in the table once the round it
// belonged to is closed (`just galley-close`), so without that filter this file
// would accumulate every note ever left on the post and re-present work already
// merged as though it still needed doing.
//
// THIS FILE IS ALSO A MANIFEST. Every note is printed with its id, and
// `just galley-close` closes exactly the ids it finds here — which is what keeps
// a close scoped to the notes the author actually read, rather than to "whatever
// looks old", a set that silently includes a second reviewer's unread feedback.
// Commit it alongside the revision that answers it.
//
// --remote or --local is REQUIRED; see scripts/database-target.mjs. Pulling
// from the wrong database reports "no notes" for a post that has them.
//
// Reads D1 through `wrangler d1 execute`, which is already authenticated as
// you. That is the whole reason there is no admin endpoint and no admin auth:
// the operator surface is a CLI you are already logged into, so the deployed
// worker never needs a way to list notes across posts.
//
// Output goes to docs/galley/<slug>.md and is meant to be committed. Reviewer
// labels are whatever was chosen when the link was minted (see
// preview-link.mjs --reviewer), so minting with initials is what keeps this
// file anonymous — nothing here strips names.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { galleyFile } from '../src/lib/galley-manifest.js';
import { renderReviewFile } from '../src/lib/galley-render.js';
import { SLUG_RE } from '../src/lib/preview.js';
import { cli, relativeToCwd } from './cli.mjs';
import { databaseFlag, databaseLabel } from './database-target.mjs';
import { listNotes } from './notes-db.mjs';

const { die, resolveDatabase, requirePost } = cli('galley-pull');

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
let slug = null;
let local = false;
let remote = false;
let out = null;
let includeClosed = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--local') {
    local = true;
  } else if (arg === '--remote') {
    remote = true;
  } else if (arg === '--all') {
    includeClosed = true;
  } else if (arg === '--out') {
    out = argv[++i];
    if (!out) die('--out requires a value');
  } else if (arg.startsWith('-') && arg !== '-') {
    die(`unknown flag ${arg}`);
  } else if (slug === null) {
    slug = arg;
  } else {
    die(`unexpected argument ${arg}`);
  }
}

if (!slug) die('usage: npm run galley -- <slug> (--remote | --local) [--all] [--out PATH]');
// Shape-checked before it reaches the SQL below. SLUG_RE admits no quotes or
// spaces, which is what makes the interpolation safe.
if (!SLUG_RE.test(slug)) die(`invalid slug ${JSON.stringify(slug)}`);

// Which database, decided explicitly. See scripts/database-target.mjs.
const useLocal = resolveDatabase({ local, remote });

// ── the post on disk ─────────────────────────────────

const sourcePath = requirePost(slug);

const source = readFileSync(sourcePath, 'utf8');
// Must match src/lib/galley.js sha256Hex exactly: same bytes, same encoding,
// lowercase hex. The whole file, frontmatter included — see that module for why.
const currentHash = createHash('sha256').update(source, 'utf8').digest('hex');
const sourceLines = source.split('\n');

// ── read the notes ───────────────────────────────────

// scripts/notes-db.mjs owns the SQL; scripts/d1.mjs owns the shell-out, the
// banner-anchored JSON parse, and the two distinct failure messages (unreachable
// database vs unparseable output).
let allRows;
try {
  allRows = listNotes(slug, { includeClosed }, { local: useLocal });
} catch (err) {
  die(err.message);
}

// Open notes are the document; closed ones are an appendix under --all. Splitting
// here rather than in two queries keeps the "N open, M closed" header honest
// about the same set the body renders.
const rows = allRows.filter((r) => r.closed_at === null);
const closedRows = allRows.filter((r) => r.closed_at !== null);

if (allRows.length === 0) {
  // Names the database, because "no notes" and "notes, but in the other one"
  // are indistinguishable otherwise -- and the second is the likelier mistake.
  // Says "open" when it is only the filter hiding them, so a post whose whole
  // round has been closed does not read as a post nobody reviewed.
  const what = includeClosed ? 'no notes' : 'no open notes';
  console.error(`galley-pull: ${what} for ${slug} (${databaseLabel(useLocal)})`);
}

// ── render ───────────────────────────────────────────
//
// Every decision about what the document SAYS lives in src/lib/galley-render.js,
// so `node --test` can reach it — the grouping, the relocation-agreement rule
// that stops a heading claiming one note's line for all of them, and the rule
// that an unchanged file's stored anchor beats a relocation. Both of those fail
// silently rather than loudly, which is why they are no longer in a file nothing
// can import. This script keeps the I/O: argv, the .mdx, D1, and the write.

const { markdown, drifted } = renderReviewFile({
  slug,
  sourcePath: relativeToCwd(sourcePath),
  sourceLines,
  currentHash,
  rows,
  closedRows,
  database: databaseLabel(useLocal),
});

if (out === '-') {
  process.stdout.write(markdown);
} else {
  const target = resolve(out ?? galleyFile(slug));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, markdown);
  console.log(relativeToCwd(target));
  console.error(
    `\n  ${rows.length} open note(s)${drifted ? `, ${drifted} against an older revision` : ''}` +
      `${closedRows.length ? `, ${closedRows.length} closed` : ''}`,
  );
  console.error('  Review, then apply with Claude alongside the .mdx.');
  // Named here because this is where the author is standing when they finish a
  // round, and because the close has to happen AFTER the revision merges -- a
  // close run now would retire notes whose fixes are not in the file yet.
  console.error(
    `\n  Applied them? Merge the revision first, then:\n` +
      `    just galley-close ${slug} ${databaseFlag(useLocal)}\n`,
  );
}
