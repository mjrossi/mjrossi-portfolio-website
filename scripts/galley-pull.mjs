// Pull a post's galley notes into docs/galley/<slug>.md, to hand to Claude
// alongside the .mdx and commit with the revision that answers it.
//
//   npm run galley -- my-draft --remote            # production notes
//   npm run galley -- my-draft --local             # the local dev database
//   npm run galley -- my-draft --remote --all      # closed rounds too
//   npm run galley -- my-draft --remote --out -    # stdout instead of docs/galley/
//
// Open notes only unless --all, or merged work would come back as to-do.
//
// THE FILE IS ALSO THE MANIFEST: `just galley-close` closes exactly the ids in
// it. The Desk renders the same reviewModel, but the pull is the artifact.
//
// --remote or --local is REQUIRED (database-target.mjs). Reviewer labels are
// whatever was minted (use initials); nothing strips names.

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
// Shape-checked: it also names the output path.
if (!SLUG_RE.test(slug)) die(`invalid slug ${JSON.stringify(slug)}`);

const useLocal = resolveDatabase({ local, remote });

// ── the post on disk ─────────────────────────────────

const sourcePath = requirePost(slug);

const source = readFileSync(sourcePath, 'utf8');
// The whole file, frontmatter included, as src/lib/galley.js requires.
const currentHash = createHash('sha256').update(source, 'utf8').digest('hex');
const sourceLines = source.split('\n');

// ── read the notes ───────────────────────────────────

let allRows;
try {
  allRows = await listNotes(slug, { includeClosed }, { local: useLocal });
} catch (err) {
  die(err.message);
}

// One query, split here, so the header counts the same set the body renders.
const rows = allRows.filter((r) => r.closed_at === null);
const closedRows = allRows.filter((r) => r.closed_at !== null);

if (allRows.length === 0) {
  // Names the database, and says "open" when only the filter hides notes.
  const what = includeClosed ? 'no notes' : 'no open notes';
  console.error(`galley-pull: ${what} for ${slug} (${databaseLabel(useLocal)})`);
}

// ── render ───────────────────────────────────────────
//
// What the document SAYS is src/lib/galley-render.js; this keeps the I/O.

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
  // The close comes AFTER the revision merges.
  console.error(
    `\n  Applied them? Merge the revision first, then:\n` +
      `    just galley-close ${slug} ${databaseFlag(useLocal)}\n`,
  );
}
