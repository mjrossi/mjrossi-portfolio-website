// Mint a signed, expiring preview link for one scheduled post.
//
//   npm run preview-link -- my-draft --remote
//   npm run preview-link -- my-draft --remote --hours 4
//   npm run preview-link -- my-draft --remote --reviewer jd
//   npm run preview-link -- my-draft --local --host http://127.0.0.1:8788
//
// --remote or --local is REQUIRED (database-target.mjs): the wrong database is
// silent until a reviewer gets a 404.
//
// --reviewer lets the holder leave galley notes under that label, which lands
// in the committed review file — use initials; nothing strips names later.
//
// The row goes into preview_links BEFORE the URL prints, so a failed insert
// hands out nothing. --hours is the row's effective window, which
// `just preview-extend` can move without changing the URL, up to the signed
// ceiling (CEILING_HOURS). The row is also clamped to pubDate; the ceiling is
// not, so a slipped launch can still be extended into.
//
// Signs with PREVIEW_SIGNING_KEY from the environment or .dev.vars, using the
// same src/lib/preview.js the worker verifies with.

import { newLinkId, signPreviewToken, SLUG_RE } from '../src/lib/preview.js';
import { clampToPublication, isPublished, publicationTime } from '../src/lib/schedule.js';
import { readPubDate } from './content.mjs';
import { cli } from './cli.mjs';
import { databaseLabel } from './database-target.mjs';
import { readDevVar } from './dev-vars.mjs';
import { recordLinks } from './links-db.mjs';

const DEFAULT_HOURS = 48;
const DEFAULT_HOST = 'https://mjrossi.com';

// The signed ceiling, and so the furthest preview-extend can go. 30 days covers
// a slow round without becoming a permanent grant. Minting policy, so it stays
// out of the worker's preview.js.
const CEILING_HOURS = 720;

const { die, resolveDatabase, requirePost } = cli('preview-link');

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
let slug = null;
let hours = DEFAULT_HOURS;
let host = DEFAULT_HOST;
let reviewer = null;
let local = false;
let remote = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--local') {
    // Pair with --host http://127.0.0.1:8788.
    local = true;
  } else if (arg === '--remote') {
    remote = true;
  } else if (arg === '--reviewer') {
    reviewer = argv[++i];
    if (!reviewer) die('--reviewer requires a value');
    // Checked here so the message explains the constraint, not a stack trace.
    if (!SLUG_RE.test(reviewer)) {
      die(
        `reviewer ${JSON.stringify(reviewer)} cannot be signed — use lowercase ` +
          'letters, digits, and dashes only.\n' +
          '  This label is recorded on every note the editor leaves and ends up in ' +
          'the committed review file, so initials are the usual choice: --reviewer jd',
      );
    }
  } else if (arg === '--hours') {
    hours = Number(argv[++i]);
    // > 0: `--hours 0` would print a link that is already expired.
    if (!Number.isFinite(hours) || hours <= 0) die('--hours must be a positive number');
  } else if (arg === '--host') {
    host = argv[++i];
    // Here rather than at `new URL`, which would say "Invalid URL" for a
    // missing value (`--host --local`).
    if (!host || host.startsWith('-')) die('--host requires a URL, e.g. http://127.0.0.1:8788');
  } else if (arg.startsWith('-')) {
    die(`unknown flag ${arg}`);
  } else if (slug === null) {
    slug = arg;
  } else {
    die(`unexpected argument ${arg}`);
  }
}

if (!slug) {
  die(
    'usage: npm run preview-link -- <slug> (--remote | --local) ' +
      '[--hours N] [--host URL] [--reviewer LABEL]',
  );
}

const useLocal = resolveDatabase({ local, remote });

// ── validate the slug against real content ───────────
//
// A typo would otherwise mint a valid link to a 404. Shape first: an
// unsupported filename would pass the existence check and die inside signing,
// and the shape check also keeps `../` out of the paths.
if (!SLUG_RE.test(slug)) {
  die(
    `slug ${JSON.stringify(slug)} cannot be signed — preview tokens accept lowercase ` +
      'letters, digits, and dashes only (the slug is part of the dot-delimited ' +
      'signed payload).\n' +
      '  If the post file really is named that way, rename it; its URL should be ' +
      'kebab-case regardless.',
  );
}

requirePost(slug);

let pubDate;
try {
  pubDate = readPubDate(slug);
} catch (err) {
  die(err.message);
}

// ── key ──────────────────────────────────────────────

// Env wins over .dev.vars; the parse is shared with smoke (dev-vars.mjs).
function readKey() {
  return process.env.PREVIEW_SIGNING_KEY || readDevVar('PREVIEW_SIGNING_KEY');
}

const key = readKey();
if (!key) {
  die(
    'PREVIEW_SIGNING_KEY not found in the environment or .dev.vars.\n' +
      '  Generate one:  openssl rand -hex 32\n' +
      '  Add to .dev.vars, and for production:  wrangler secret put PREVIEW_SIGNING_KEY',
  );
}

// ── mint ─────────────────────────────────────────────

// `exp` is the row's, and movable; `maxExp` is signed and fixed. --hours past
// the ceiling collapses them, leaving no headroom — said out loud below.
const nowSec = Math.floor(Date.now() / 1000);
const requested = nowSec + Math.round(hours * 3600);
const maxExp = nowSec + Math.round(Math.max(hours, CEILING_HOURS) * 3600);

// Publication is the third bound, and usually the first to bite. An
// already-published post skips the clamp, which would return a past expiry:
// minting on a live post is how the local galley trial loop works.
const live = isPublished(pubDate);
const exp = live ? requested : clampToPublication(requested, pubDate);
const cappedByPublication = !live && exp < requested;

// What preview-extend could actually reach: the ceiling, clamped to publication.
const extendLimit = live ? maxExp : Math.min(maxExp, publicationTime(pubDate));

const linkId = newLinkId();
const token = await signPreviewToken({ slug, exp: maxExp, reviewer, linkId }, key);
const url = new URL(`/blog/${slug}/`, host);
url.searchParams.set('preview', token);

// Record BEFORE printing; a link with no row would be refused on arrival.
try {
  await recordLinks([{ id: linkId, slug, reviewer, exp, maxExp }], { local: useLocal });
} catch (err) {
  die(
    `minted a token but could not record it in the ${databaseLabel(useLocal)} ` +
      `database, so it would be refused on arrival:\n${err.message}`,
  );
}

const target = useLocal ? '--local' : '--remote';

console.log(url.href);
// The database first, on every mint: a link in the wrong one looks valid.
console.error(`\n  database: ${databaseLabel(useLocal)}`);
console.error(`  post:     ${slug}`);
console.error(
  live
    ? `  publish:  already live since ${pubDate.toISOString()}`
    : `  publish:  ${pubDate.toISOString()} — this link ends there`,
);
console.error(
  cappedByPublication
    ? `  expires:  ${new Date(exp * 1000).toISOString()} — publication, not the ${hours}h asked for`
    : `  expires:  ${new Date(exp * 1000).toISOString()} (${hours}h)`,
);
console.error(
  extendLimit > exp
    ? `  extend:   up to ${new Date(extendLimit * 1000).toISOString()} — the URL above ` +
        'keeps working, so nothing is re-sent'
    : cappedByPublication
      ? '  extend:   not while the date stands — this link already runs to publication.\n' +
        `            Push pubDate back and re-run just preview-extend ${slug} --all ${target};\n` +
        `            the signature allows up to ${new Date(maxExp * 1000).toISOString()}.`
      : `  extend:   no headroom — --hours ${hours} already reaches the ceiling, so ` +
        'a longer window means a new link',
);
console.error(
  reviewer
    ? `  grants:   read + leave galley notes, attributed to "${reviewer}"`
    : '  grants:   read only — pass --reviewer LABEL to let them leave notes',
);
console.error('  scope:    this post only — the link does not reveal anything else');
console.error(`  link id:  ${linkId}`);
console.error(`    revoke:  just preview-revoke ${linkId} ${target}`);
console.error(`    extend:  just preview-extend ${linkId} --hours N ${target}\n`);

// Said out loud: a link to a post an hour from publication has an hour on it.
if (cappedByPublication && exp - nowSec < 3600) {
  const minutes = Math.max(1, Math.round((exp - nowSec) / 60));
  console.error(
    `  NOTE: ${slug} publishes in ${minutes} minute(s), so that is all this link has.\n` +
      '        It is about to be public anyway — send the plain URL instead.\n',
  );
}
