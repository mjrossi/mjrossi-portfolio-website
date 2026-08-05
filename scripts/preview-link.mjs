// Mint a signed, expiring preview link for one scheduled blog post.
//
//   npm run preview-link -- my-draft --remote
//   npm run preview-link -- my-draft --remote --hours 4
//   npm run preview-link -- my-draft --remote --reviewer jd
//   npm run preview-link -- my-draft --local --host http://127.0.0.1:8788
//
// --remote or --local is REQUIRED; see scripts/database-target.mjs. Minting
// against the wrong database is silent at the time and shows up as a 404 in
// somebody else's browser.
//
// Without --reviewer the link is read-only. With it, the holder can also leave
// galley notes on that post, attributed to the label given. The label is
// recorded on every note and ends up in the committed review file, so use
// initials — that is the whole of the anonymisation story, and there is no
// later step that strips names.
//
// EVERY link minted here is recorded in the preview_links allowlist, and
// middleware refuses a token whose row is missing or revoked — so a link can be
// withdrawn with `just preview-revoke <slug> <id>`, and `just preview-roster
// <slug>` lists what is outstanding. The row is written BEFORE the URL prints:
// a link that verifies but has no row looks exactly like a broken feature, so
// a failed insert hands out nothing at all.
//
// That means minting needs D1 — a token carrying D1:Edit for production, or
// --local for the database `just preview` and `just smoke` run against.
//
// Signs with PREVIEW_SIGNING_KEY, read from the environment or (more usually)
// from .dev.vars. That file is the local home for worker-runtime secrets, and
// it is the one place a worker secret is legitimately read outside wrangler:
// HMAC requires the minting side and the verifying side to share a key.
//
// The signing and verifying code is the same module the Worker uses
// (src/lib/preview.js), so a link that verifies here verifies in production.

import { newLinkId, signPreviewToken, SLUG_RE } from '../src/lib/preview.js';
import { resolvePostSource } from './content.mjs';
import { chooseDatabase, databaseLabel } from './database-target.mjs';
import { readDevVar } from './dev-vars.mjs';
import { recordLinks } from './links-db.mjs';

const DEFAULT_HOURS = 48;
const DEFAULT_HOST = 'https://mjrossi.com';

function die(message) {
  console.error(`preview-link: ${message}`);
  process.exit(1);
}

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
    // Record against the local D1 that `just preview` and `just smoke` use,
    // rather than production. Pair it with --host http://127.0.0.1:8788.
    local = true;
  } else if (arg === '--remote') {
    remote = true;
  } else if (arg === '--reviewer') {
    reviewer = argv[++i];
    if (!reviewer) die('--reviewer requires a value');
    // Same shape as a slug, because both are fields in the dot-delimited
    // signed payload. Rejected here rather than inside signPreviewToken so the
    // message explains the constraint instead of showing a stack trace.
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
    // Must be > 0, not >= 0: `--hours 0` mints a token that is already expired
    // by the time it is printed, and verifyPreviewToken treats expiry as
    // exclusive. A link that 404s the instant you send it looks like a broken
    // feature rather than a bad argument, so reject it here.
    if (!Number.isFinite(hours) || hours <= 0) die('--hours must be a positive number');
  } else if (arg === '--host') {
    host = argv[++i];
    // Rejected here rather than at `new URL` below, which would report
    // "Invalid URL" and a stack trace for what is really a missing value.
    // `--host --local` is the easy way to hit this.
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

// Which database, decided explicitly. See scripts/database-target.mjs for why
// there is no default: minting against the wrong one is silent either way.
let useLocal;
try {
  useLocal = chooseDatabase({ local, remote });
} catch (err) {
  die(err.message);
}

// ── validate the slug against real content ───────────
//
// Without this, a typo mints a perfectly valid link to a post that doesn't
// exist — the reviewer gets a 404 and you have no way to tell whether the
// feature is broken or the slug was wrong.

// Shape first, existence second. signPreviewToken only accepts SLUG_RE, so a
// post filed as `My_Post.mdx` would otherwise pass the existence check below
// and then die with a raw stack trace from deep inside the signing call —
// which reads like the tool is broken rather than the input unsupported.
// Checking here also means the paths built below can't contain `../`.
if (!SLUG_RE.test(slug)) {
  die(
    `slug ${JSON.stringify(slug)} cannot be signed — preview tokens accept lowercase ` +
      'letters, digits, and dashes only (the slug is part of the dot-delimited ' +
      'signed payload).\n' +
      '  If the post file really is named that way, rename it; its URL should be ' +
      'kebab-case regardless.',
  );
}

if (!resolvePostSource(slug)) {
  die(`no post found for slug ${JSON.stringify(slug)} (looked for ${slug}.mdx and ${slug}/index.mdx)`);
}

// ── key ──────────────────────────────────────────────

// Env wins over .dev.vars; the file parse is shared with scripts/smoke.mjs so
// the two can't disagree on quoting. See scripts/dev-vars.mjs.
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

const exp = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
const linkId = newLinkId();
const token = await signPreviewToken({ slug, exp, reviewer, linkId }, key);
const url = new URL(`/blog/${slug}/`, host);
url.searchParams.set('preview', token);

// Record BEFORE printing. A link whose row failed to write verifies its
// signature and is then refused by middleware, which looks exactly like the
// feature being broken — so if this fails, no URL is handed out at all.
try {
  recordLinks([{ id: linkId, slug, reviewer, exp }], { local: useLocal });
} catch (err) {
  die(
    `minted a token but could not record it in the ${databaseLabel(useLocal)} ` +
      `database, so it would be refused on arrival:\n${err.message}`,
  );
}

console.log(url.href);
// Which database is printed FIRST, and on every mint. A link recorded in the
// wrong one still looks entirely valid -- it is the arriving reviewer who finds
// out, by getting a 404 that reads like the post was pulled.
console.error(`\n  database: ${databaseLabel(useLocal)}`);
console.error(`  post:     ${slug}`);
console.error(`  expires:  ${new Date(exp * 1000).toISOString()} (${hours}h)`);
console.error(
  reviewer
    ? `  grants:   read + leave galley notes, attributed to "${reviewer}"`
    : '  grants:   read only — pass --reviewer LABEL to let them leave notes',
);
console.error('  scope:    this post only — the link does not reveal anything else');
console.error(
  `  link id:  ${linkId}  (just preview-revoke ${slug} ${linkId} ` +
    `${useLocal ? '--local' : '--remote'})\n`,
);
