// Pull galley notes for one post into a markdown file you can hand to Claude
// alongside the .mdx.
//
//   npm run galley -- my-draft --remote            # production notes
//   npm run galley -- my-draft --local             # the local dev database
//   npm run galley -- my-draft --remote --out -    # stdout instead of docs/galley/
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
import { createLocator, pushFenced, pushQuoted } from '../src/lib/galley-relocate.js';
import { SLUG_RE } from '../src/lib/preview.js';
import { resolvePostSource } from './content.mjs';
import { chooseDatabase, databaseLabel } from './database-target.mjs';
import { d1Query } from './d1.mjs';

function die(message) {
  console.error(`galley-pull: ${message}`);
  process.exit(1);
}

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
let slug = null;
let local = false;
let remote = false;
let out = null;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--local') {
    local = true;
  } else if (arg === '--remote') {
    remote = true;
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

if (!slug) die('usage: npm run galley -- <slug> (--remote | --local) [--out PATH]');
// Shape-checked before it reaches the SQL below. SLUG_RE admits no quotes or
// spaces, which is what makes the interpolation safe.
if (!SLUG_RE.test(slug)) die(`invalid slug ${JSON.stringify(slug)}`);

// Which database, decided explicitly. See scripts/database-target.mjs.
let useLocal;
try {
  useLocal = chooseDatabase({ local, remote });
} catch (err) {
  die(err.message);
}

// ── the post on disk ─────────────────────────────────

const sourcePath = resolvePostSource(slug);
if (!sourcePath) die(`no post found for slug ${JSON.stringify(slug)}`);

const source = readFileSync(sourcePath, 'utf8');
// Must match src/lib/galley.js sha256Hex exactly: same bytes, same encoding,
// lowercase hex. The whole file, frontmatter included — see that module for why.
const currentHash = createHash('sha256').update(source, 'utf8').digest('hex');
const sourceLines = source.split('\n');

// ── locating a quote in the current source ───────────

// fold / unmark / locate and the reviewer-text emitters live in
// src/lib/galley-relocate.js so `node --test` can reach them — this file parses
// argv and shells out to wrangler at import time, which makes it unimportable,
// and that logic is the least obvious part of the feature.
const locate = createLocator(sourceLines);

/** The quote with its stored context, for a human to search by hand. */
function contextHint(note) {
  const ctx = `${note.prefix ?? ''}${note.quote ?? ''}${note.suffix ?? ''}`.trim();
  return ctx || null;
}

/**
 * The source line to show under a heading, skipping a code fence.
 *
 * `code` nodes are anchored across their whole span, fences included, so a note
 * on a code block resolves to the ``` line rather than to any code. Advance to
 * the first line with content on it so the excerpt shows what the note is
 * actually about. Bounded to a few lines: past that the anchor is pointing
 * somewhere unexpected, and printing nothing beats printing something
 * misleading.
 */
function excerptAt(index) {
  for (let i = index; i < Math.min(index + 4, sourceLines.length); i++) {
    const text = sourceLines[i]?.trim();
    if (!text) continue;
    if (/^(`{3,}|~{3,})/.test(text)) continue;
    return text;
  }
  return null;
}

// ── read the notes ───────────────────────────────────

const sql = `SELECT id, revision_hash, reviewer, kind, src_start, src_end,
                    quote, prefix, suffix, body, suggestion, status, created_at
               FROM galley_notes
              WHERE slug = '${slug}'
              ORDER BY created_at ASC`;

// scripts/d1.mjs owns the shell-out, the banner-anchored JSON parse, and the
// two distinct failure messages (unreachable database vs unparseable output).
let rows;
try {
  rows = d1Query(sql, { local: useLocal });
} catch (err) {
  die(err.message);
}

if (rows.length === 0) {
  // Names the database, because "no notes" and "notes, but in the other one"
  // are indistinguishable otherwise -- and the second is the likelier mistake.
  console.error(`galley-pull: no notes for ${slug} (${databaseLabel(useLocal)})`);
}

// ── render ───────────────────────────────────────────

const drifted = rows.filter((r) => r.revision_hash !== currentHash).length;

const lines = [];
lines.push(`# Review notes — ${slug}`);
lines.push('');
lines.push(`Pulled ${new Date().toISOString()} from \`${databaseLabel(useLocal)}\`.`);
lines.push(`${rows.length} note${rows.length === 1 ? '' : 's'}, ${new Set(rows.map((r) => r.reviewer)).size} reviewer(s).`);
lines.push('');
if (drifted > 0) {
  lines.push(
    `> **${drifted} of these were written against an earlier revision.** Their stored line ` +
      'numbers are stale. Where the quoted text was still findable, the current line is ' +
      'given as "now line N" — otherwise search for the quote by hand.',
  );
  lines.push('');
}
lines.push(`Source: \`${sourcePath.replace(`${process.cwd()}/`, '')}\``);
lines.push('');
lines.push('---');
lines.push('');

// Group by anchor so several notes on the same passage read together, with
// unanchored whole-draft notes last.
const groups = new Map();
for (const row of rows) {
  const key = row.src_start ? `${row.src_start}-${row.src_end}` : 'general';
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
const ordered = [...groups.entries()].sort((a, b) => {
  if (a[0] === 'general') return 1;
  if (b[0] === 'general') return -1;
  return Number(a[0].split('-')[0]) - Number(b[0].split('-')[0]);
});

for (const [key, notes] of ordered) {
  // Declared out here because the per-note loop below needs it: when the group
  // could NOT agree on a single relocation, each note carries its own.
  let current = null;
  if (key === 'general') {
    lines.push('## Whole-draft notes');
  } else {
    const stale = notes.some((n) => n.revision_hash !== currentHash);

    // Resolve EVERY quoted note in the group, not just the first. Notes share
    // an anchor whenever they were filed against the same block, but they can
    // quote different sentences within it — so a single "now line N" taken from
    // whichever note happened to sort first was being presented as the heading
    // for all of them. Claim a relocation on the heading only when the group
    // agrees; otherwise each note carries its own below.
    for (const note of notes) note.currentLine = locate(note.quote, note.prefix, note.suffix);
    const resolved = notes.filter((n) => n.quote).map((n) => n.currentLine);
    const agreed = new Set(resolved.filter((line) => line !== null));
    current = resolved.length > 0 && resolved.every(Boolean) && agreed.size === 1
      ? [...agreed][0]
      : null;

    let heading = `## Line ${key}`;
    if (stale) {
      if (current) {
        heading += ` — now line ${current}`;
      } else if (resolved.some(Boolean)) {
        // Found, but not all in the same place — these notes share an anchor
        // while quoting different sentences. Saying "not found" here would be
        // wrong, and saying "now line N" would pick one of them arbitrarily.
        heading += ' — ⚠ revision drift, notes relocated individually below';
      } else {
        heading += ' — ⚠ revision drift, quote not found';
      }
    }
    lines.push(heading);
    if (!stale || current) {
      // When the file has NOT drifted the stored anchor is authoritative by
      // definition, so it wins over a relocation. Preferring `current`
      // unconditionally could put a heading reading "## Line 42-47" above an
      // excerpt taken from somewhere else entirely — the quote resolving
      // elsewhere in an unchanged file means the anchor is the trustworthy half.
      const at = (stale ? current : Number(key.split('-')[0])) - 1;
      const text = excerptAt(at);
      if (text) {
        lines.push('');
        pushFenced(lines, text.length > 300 ? `${text.slice(0, 300)}…` : text, 'md');
      }
    }
  }
  lines.push('');

  for (const note of notes) {
    const when = new Date(note.created_at).toISOString().slice(0, 10);
    let meta = `**${note.reviewer}** · ${note.kind} · ${when}`;
    // Per-note relocation, for the case the heading could not claim one: the
    // notes in this group resolve to different lines, so each says where its
    // own passage went.
    if (key !== 'general' && !current && note.currentLine) meta += ` · now line ${note.currentLine}`;
    lines.push(meta);
    lines.push('');
    if (note.quote) {
      pushQuoted(lines, note.quote);
      lines.push('');
      // Nothing else in this file can point at the passage, so hand over the
      // context the note was written against. This is the case prefix/suffix
      // were recorded for and that locate() could not resolve on its own.
      if (key !== 'general' && !note.currentLine) {
        const hint = contextHint(note);
        if (hint) {
          // Blockquoted like every other reviewer-authored string in this file.
          // prefix/suffix are stored verbatim and `clean()` only trims the ends,
          // so newlines survive — interpolating this raw would let a note forge
          // a `##` heading in a document whose headings are how notes get
          // attributed to passages.
          lines.push('Context when written:');
          lines.push('');
          pushQuoted(lines, `…${hint}…`);
          lines.push('');
        }
      }
    }
    if (note.body) {
      pushQuoted(lines, note.body);
      lines.push('');
    }
    if (note.suggestion) {
      lines.push('Suggested replacement:');
      lines.push('');
      pushFenced(lines, note.suggestion, 'md');
      lines.push('');
    }
  }
  lines.push('---');
  lines.push('');
}

const markdown = `${lines.join('\n').trimEnd()}\n`;

if (out === '-') {
  process.stdout.write(markdown);
} else {
  const target = resolve(out ?? `docs/galley/${slug}.md`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, markdown);
  console.log(target.replace(`${process.cwd()}/`, ''));
  console.error(`\n  ${rows.length} note(s)${drifted ? `, ${drifted} against an older revision` : ''}`);
  console.error('  Review, then apply with Claude alongside the .mdx.\n');
}
