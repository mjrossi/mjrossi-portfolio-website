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
// --hours is the EFFECTIVE window and is recorded on the row, where
// `just preview-extend` can move it later without changing the URL. The token
// is signed with a ceiling further out (CEILING_HOURS below), which is the
// furthest that link can ever be extended. So mint the window you actually
// mean: a short one costs nothing now that more time does not mean a new link.
//
// PUBLICATION CUTS IT SHORTER STILL. The row's expiry is clamped to the post's
// pubDate, because a link to a draft has nothing left to grant once the draft is
// public — and left running it would hold the galley open on a live post. The
// SIGNATURE ceiling is deliberately not clamped, so pushing pubDate back leaves
// headroom: `just preview-extend <slug> --all` then re-clamps every outstanding
// link to the new date, and not one URL changes.
//
// Signs with PREVIEW_SIGNING_KEY, read from the environment or (more usually)
// from .dev.vars. That file is the local home for worker-runtime secrets, and
// it is the one place a worker secret is legitimately read outside wrangler:
// HMAC requires the minting side and the verifying side to share a key.
//
// The signing and verifying code is the same module the Worker uses
// (src/lib/preview.js), so a link that verifies here verifies in production.

import { newLinkId, signPreviewToken, SLUG_RE } from '../src/lib/preview.js';
import { clampToPublication, isPublished, publicationTime } from '../src/lib/schedule.js';
import { readPubDate } from './content.mjs';
import { cli } from './cli.mjs';
import { databaseLabel } from './database-target.mjs';
import { readDevVar } from './dev-vars.mjs';
import { recordLinks } from './links-db.mjs';

const DEFAULT_HOURS = 48;
const DEFAULT_HOST = 'https://mjrossi.com';

// The ceiling: how far past the requested window the SIGNED exp is set, and so
// the furthest `just preview-extend` can ever move this link. Two clocks, one
// signed and one not -- see migrations/0002 for why.
//
// 30 days is chosen to cover a slow review round without becoming a de facto
// permanent grant. Minting policy, so it lives here rather than in
// src/lib/preview.js, which is the copy that ships to the worker and is
// deliberately free of anything the worker does not need.
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
const useLocal = resolveDatabase({ local, remote });

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

requirePost(slug);

// When the post goes live, which is also when this link stops being worth
// anything. Read from the same frontmatter the build reads — see readPubDate.
let pubDate;
try {
  pubDate = readPubDate(slug);
} catch (err) {
  die(err.message);
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

// Two expiries. `exp` is the effective one and lives in the row, where
// `just preview-extend` can move it without changing the URL. `maxExp` is the
// ceiling and goes inside the signature, where nothing can move it at all.
//
// --hours longer than the ceiling collapses them: you asked for the whole
// window up front, so there is no headroom left to extend into. Said out loud
// below rather than left to be discovered later.
const nowSec = Math.floor(Date.now() / 1000);
const requested = nowSec + Math.round(hours * 3600);
const maxExp = nowSec + Math.round(Math.max(hours, CEILING_HOURS) * 3600);

// PUBLICATION IS THE THIRD BOUND on the clock, after the requested window and
// the signature ceiling — and usually the first one to bite. A link exists to
// show someone a post that isn't public yet, so it has nothing left to grant the
// moment it is; letting it run on would leave the galley open on a live post and
// the roster reporting a link as live when it is merely still in the table.
//
// An ALREADY-PUBLISHED post skips the clamp and mints exactly as before. The
// clamp would hand back an expiry in the past — a link dead on arrival — and
// minting against a live post is a legitimate thing to do: it is how the local
// galley trial loop in CLAUDE.md works, on whichever post is handy.
const live = isPublished(pubDate);
const exp = live ? requested : clampToPublication(requested, pubDate);
const cappedByPublication = !live && exp < requested;

// How far `just preview-extend` could actually move this link. The signature
// ceiling is one limit and publication is the other, and the roster's own
// `extend to` suffix means the same thing — reporting the raw ceiling here would
// promise headroom that preview-extend then clamps away.
const extendLimit = live ? maxExp : Math.min(maxExp, publicationTime(pubDate));

const linkId = newLinkId();
const token = await signPreviewToken({ slug, exp: maxExp, reviewer, linkId }, key);
const url = new URL(`/blog/${slug}/`, host);
url.searchParams.set('preview', token);

// Record BEFORE printing. A link whose row failed to write verifies its
// signature and is then refused by middleware, which looks exactly like the
// feature being broken — so if this fails, no URL is handed out at all.
try {
  recordLinks([{ id: linkId, slug, reviewer, exp, maxExp }], { local: useLocal });
} catch (err) {
  die(
    `minted a token but could not record it in the ${databaseLabel(useLocal)} ` +
      `database, so it would be refused on arrival:\n${err.message}`,
  );
}

const target = useLocal ? '--local' : '--remote';

console.log(url.href);
// Which database is printed FIRST, and on every mint. A link recorded in the
// wrong one still looks entirely valid -- it is the arriving reviewer who finds
// out, by getting a 404 that reads like the post was pulled.
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
console.error(`    revoke:  just preview-revoke ${slug} ${linkId} ${target}`);
console.error(`    extend:  just preview-extend ${slug} ${linkId} --hours N ${target}\n`);

// Said out loud, because it is the one case where a correct link is useless. A
// post an hour from publication mints a link with an hour on it, which reads as
// a broken feature to whoever opens it after lunch.
if (cappedByPublication && exp - nowSec < 3600) {
  const minutes = Math.max(1, Math.round((exp - nowSec) / 60));
  console.error(
    `  NOTE: ${slug} publishes in ${minutes} minute(s), so that is all this link has.\n` +
      '        It is about to be public anyway — send the plain URL instead.\n',
  );
}
