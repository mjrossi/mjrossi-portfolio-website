// Mint a signed, expiring preview link for one scheduled blog post.
//
//   npm run preview-link -- my-draft
//   npm run preview-link -- my-draft --hours 4
//   npm run preview-link -- my-draft --host http://127.0.0.1:8788
//
// Signs with PREVIEW_SIGNING_KEY, read from the environment or (more usually)
// from .dev.vars. That file is the local home for worker-runtime secrets, and
// it is the one place a worker secret is legitimately read outside wrangler:
// HMAC requires the minting side and the verifying side to share a key.
//
// The signing and verifying code is the same module the Worker uses
// (src/lib/preview.js), so a link that verifies here verifies in production.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { signPreviewToken, SLUG_RE } from '../src/lib/preview.js';
import { readDevVar } from './dev-vars.mjs';

const DEFAULT_HOURS = 48;
const DEFAULT_HOST = 'https://mjrossi.com';
const CONTENT_DIR = resolve('src/content/blog');

function die(message) {
  console.error(`preview-link: ${message}`);
  process.exit(1);
}

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
let slug = null;
let hours = DEFAULT_HOURS;
let host = DEFAULT_HOST;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--hours') {
    hours = Number(argv[++i]);
    // Must be > 0, not >= 0: `--hours 0` mints a token that is already expired
    // by the time it is printed, and verifyPreviewToken treats expiry as
    // exclusive. A link that 404s the instant you send it looks like a broken
    // feature rather than a bad argument, so reject it here.
    if (!Number.isFinite(hours) || hours <= 0) die('--hours must be a positive number');
  } else if (arg === '--host') {
    host = argv[++i];
    if (!host) die('--host requires a value');
  } else if (arg.startsWith('-')) {
    die(`unknown flag ${arg}`);
  } else if (slug === null) {
    slug = arg;
  } else {
    die(`unexpected argument ${arg}`);
  }
}

if (!slug) {
  die('usage: npm run preview-link -- <slug> [--hours N] [--host URL]');
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

const candidates = [
  resolve(CONTENT_DIR, `${slug}.mdx`),
  resolve(CONTENT_DIR, slug, 'index.mdx'),
];
if (!candidates.some(existsSync)) {
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
const token = await signPreviewToken(slug, exp, key);
const url = new URL(`/blog/${slug}/`, host);
url.searchParams.set('preview', token);

console.log(url.href);
console.error(`\n  post:    ${slug}`);
console.error(`  expires: ${new Date(exp * 1000).toISOString()} (${hours}h)`);
console.error('  scope:   this post only — the link does not reveal anything else\n');
