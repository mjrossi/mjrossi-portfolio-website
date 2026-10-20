// Move the expiry of a preview link that already exists. THE URL DOES NOT
// CHANGE, so nothing is re-sent.
//
//   npm run preview-extend -- a1b2c3d4e5f60718 --remote
//   npm run preview-extend -- a1b2c3d4e5f60718 --remote --hours 96
//   npm run preview-extend -- my-draft a1b2c3d4e5f60718 --remote   # post asserted
//   npm run preview-extend -- my-draft --all --remote --hours 96
//
// --remote or --local is REQUIRED (database-target.mjs).
//
// The post comes off the link's row. A slug before the id is an ASSERTION,
// refused if it disagrees (resolve-id.mjs).
//
// What moves is the row's `exp`, which isLinkActive checks; the signed `exp` is
// the cap it can never pass (migrations/0002). --hours is a new window FROM
// NOW, so this shortens as readily as it extends (`--hours 1` is the gentle
// revoke). The window is clamped to pubDate; a published post is refused.
//
// --all re-clamps every LIVE link for a post, for "I pushed the date out".
//
// Refusals are specific: an UPDATE that changed nothing looks the same for
// every cause, and someone is waiting on this.

import { isoDay } from '../src/lib/galley-render.js';
import { LINK_ID_RE, SLUG_RE } from '../src/lib/preview.js';
import { clampToPublication, isPublished } from '../src/lib/schedule.js';
import { readPubDate } from './content.mjs';
import { cli } from './cli.mjs';
import { databaseLabel } from './database-target.mjs';
import { linkState } from '../src/lib/link-state.js';
import { extendLink, extendLinks, listLinks } from './links-db.mjs';
import { resolveLink } from './resolve-id.mjs';

const DEFAULT_HOURS = 48;

const { die, resolveDatabase } = cli('preview-extend');

/** Epoch seconds → the ISO form used by preview-link's own output. */
function iso(sec) {
  return new Date(sec * 1000).toISOString();
}

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
const positional = [];
let hours = DEFAULT_HOURS;
let local = false;
let remote = false;
let all = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--local') {
    local = true;
  } else if (arg === '--remote') {
    remote = true;
  } else if (arg === '--all') {
    all = true;
  } else if (arg === '--hours') {
    hours = Number(argv[++i]);
    // > 0: `--hours 0` is a revoke wearing the wrong name; use preview-revoke.
    if (!Number.isFinite(hours) || hours <= 0) {
      die('--hours must be a positive number (to take a link back, use just preview-revoke)');
    }
  } else if (arg.startsWith('-')) {
    die(`unknown flag ${arg}`);
  } else {
    positional.push(arg);
  }
}

// Two shapes; --all is the only mode whose subject is a post:
//
//   --all      <slug>            re-clamp every live link for that post
//   (default)  <id>              one link; the post comes off the row
//   (default)  <slug> <id>       the same, with the post asserted
//
// A lone non-id is refused rather than read as a slug: `preview-extend
// my-draft` is a missing --all, not a missing link.
let slug = null;
let id = null;

if (all) {
  if (positional.length !== 1) {
    die('usage: npm run preview-extend -- <slug> --all (--remote | --local) [--hours N]');
  }
  slug = positional[0];
} else if (positional.length === 1) {
  id = positional[0];
  if (!LINK_ID_RE.test(id)) {
    die(
      `expected a link id, got ${JSON.stringify(id)}.\n` +
        '  Ids are 16 lowercase hex characters — `just preview-roster` lists them.\n' +
        '  To move every link for a post instead, add --all.',
    );
  }
} else if (positional.length === 2) {
  [slug, id] = positional;
} else {
  die(
    'usage: npm run preview-extend -- (<link-id> | <slug> --all) (--remote | --local) [--hours N]',
  );
}

if (slug !== null && !SLUG_RE.test(slug)) die(`invalid slug ${JSON.stringify(slug)}`);

const useLocal = resolveDatabase({ local, remote });

const where = databaseLabel(useLocal);

let resolvedRow = null;
if (!all) {
  ({ slug, row: resolvedRow } = await resolveLink(die, id, { slug, local: useLocal }));
}

// ── how far the clock can go ─────────────────────────
//
//
// Publication, read from the post; the signature ceiling is enforced in the UPDATE.

let pubDate;
try {
  pubDate = readPubDate(slug);
} catch (err) {
  die(err.message);
}
if (pubDate === null) {
  die(`no post found for slug ${JSON.stringify(slug)} (looked for ${slug}.mdx and ${slug}/index.mdx)`);
}

if (isPublished(pubDate)) {
  die(
    `${slug} published on ${pubDate.toISOString()} — its preview links have nothing left to grant.\n` +
      '  The post is public, so send the plain URL. If you meant to pull it back off the site,\n' +
      '  move its pubDate into the future; the links can then be extended again.',
  );
}

// ── extend ───────────────────────────────────────────

const nowSec = Math.floor(Date.now() / 1000);
const requested = nowSec + Math.round(hours * 3600);
// Clamped, not refused: "you have until it goes live".
const exp = clampToPublication(requested, pubDate);
const cappedByPublication = exp < requested;

let changed;
try {
  changed = all
    ? await extendLinks(slug, exp, { local: useLocal })
    : await extendLink(slug, id, exp, { local: useLocal });
} catch (err) {
  die(err.message);
}

// ── --all: report per link, since some may not have moved ────

if (all) {
  let rows;
  try {
    rows = await listLinks(slug, { local: useLocal });
  } catch (err) {
    die(err.message);
  }

  const moved = new Set(changed.map((row) => row.id));
  // link-state.js's "live", the same set the UPDATE matched; a live row it
  // didn't move can only have failed the ceiling.
  const live = rows.filter((row) => linkState(row, { pubDate }).live);
  const lapsed = rows.filter((row) => linkState(row, { pubDate }).state === 'expired');
  const stuck = live.filter((row) => !moved.has(row.id));

  if (live.length === 0) {
    die(
      `no live links for ${slug} (${where}).\n` +
        `  just preview-roster ${slug} ${useLocal ? '--local' : '--remote'} shows what is in the table.`,
    );
  }

  console.error(
    `preview-extend: moved ${changed.length} of ${live.length} live link(s) for ${slug} ` +
      `to ${iso(exp)} (${where})\n`,
  );
  console.error(`  database: ${where}`);
  console.error(`  post:     ${slug}`);
  console.error(`  publish:  ${pubDate.toISOString()}`);
  console.error(
    cappedByPublication
      ? `  expires:  ${iso(exp)} — publication, not the ${hours}h asked for`
      : `  expires:  ${iso(exp)} (${hours}h from now)`,
  );
  for (const row of changed) console.error(`    moved:   ${row.id}`);
  for (const row of stuck) {
    console.error(`    STUCK:   ${row.id} — signed only to ${iso(row.max_exp)}; mint a fresh link`);
  }
  for (const row of lapsed) {
    console.error(`    skipped: ${row.id} — already expired; extend it by id to revive it`);
  }
  console.error('  link:     unchanged — the URLs the reviewers already have keep working\n');
  process.exit(stuck.length === 0 ? 0 : 1);
}

if (changed.length === 0) {
  // resolveLink already fetched the row, so only the reasons an EXISTING row
  // refused to move are left.
  const row = resolvedRow;

  if (row.revoked_at) {
    die(
      `link ${id} was revoked on ${isoDay(row.revoked_at)} ` +
        `(${where}).\n  Revoking is final — mint a fresh link with just preview-link instead.`,
    );
  }
  if (exp > row.max_exp) {
    die(
      `${cappedByPublication ? 'publication is' : `${hours}h would run to`} ${iso(exp)}, ` +
        `past the ceiling this link was signed with (${iso(row.max_exp)}).\n` +
        '  The ceiling is inside the signature and cannot be moved from here — that is what\n' +
        '  stops an extendable link from becoming a permanent one. Mint a fresh link, or\n' +
        `  extend to at most ${iso(row.max_exp)}.`,
    );
  }
  // Not the ceiling, which was just ruled out.
  die(
    `the update matched no row for ${id} (${where}), and the row itself looks extendable.\n` +
      '  Re-run just preview-roster ' +
      `${slug} ${useLocal ? '--local' : '--remote'}` +
      ' to see its current state.',
  );
}

// ── report ───────────────────────────────────────────
//
//
// All to stderr, unlike preview-link: there is no new URL to pipe, and printing
// the old one would invite re-sending it.

const row = changed[0];
// The ceiling or publication, whichever is first.
const limit = clampToPublication(row.max_exp, pubDate);
const headroom = limit > row.exp ? iso(limit) : null;

console.error(`preview-extend: ${row.id} on ${slug} now expires ${iso(row.exp)} (${where})\n`);
console.error(`  database: ${where}`);
console.error(`  post:     ${slug}`);
console.error(`  link id:  ${row.id}`);
console.error(`  publish:  ${pubDate.toISOString()}`);
console.error(
  cappedByPublication
    ? `  expires:  ${iso(row.exp)} — publication, not the ${hours}h asked for`
    : `  expires:  ${iso(row.exp)} (${hours}h from now)`,
);
console.error(
  headroom
    ? `  ceiling:  ${headroom} — the furthest this link can ever be extended`
    : cappedByPublication
      ? '  ceiling:  reached — this link already runs to publication. Push pubDate back\n' +
        `            and re-run with --all; the signature allows up to ${iso(row.max_exp)}.`
      : '  ceiling:  reached — this link cannot be extended again; mint a new one',
);
console.error('  link:     unchanged — the URL the reviewer already has keeps working\n');
