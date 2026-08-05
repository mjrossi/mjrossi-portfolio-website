// List and revoke the preview links minted for one post.
//
//   npm run preview-roster -- my-draft                    # list
//   npm run preview-roster -- my-draft --revoke <id>      # revoke one
//   npm run preview-roster -- my-draft --revoke-all       # revoke every live one
//   npm run preview-roster -- my-draft --local            # the dev database
//
// Reads and writes D1 through `wrangler d1 execute`, which is already
// authenticated as you. That is the whole reason there is no admin endpoint:
// the operator surface is a CLI you are already logged into, so the deployed
// worker never needs a way to enumerate or mutate links — and handing someone
// one draft must not hand them the rest.
//
// This list is the ONLY inventory. A token is recorded nowhere else, so a link
// missing from here cannot be revoked, only waited out.
//
// Revoking sets revoked_at; rows are never deleted, so a withdrawn link stays
// listed rather than vanishing. It removes READING as well as writing — the
// post 404s for that link.

import { LINK_ID_RE, SLUG_RE } from '../src/lib/preview.js';
import { listLinks, revokeLinks } from './links-db.mjs';

function die(message) {
  console.error(`preview-roster: ${message}`);
  process.exit(1);
}

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
let slug = null;
let local = false;
let revokeId = null;
let revokeAll = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--local') {
    local = true;
  } else if (arg === '--revoke') {
    revokeId = argv[++i];
    if (!revokeId) die('--revoke requires a link id');
    // Checked here as well as in links-db so the message names the constraint
    // rather than surfacing a validation error from two modules down.
    if (!LINK_ID_RE.test(revokeId)) {
      die(
        `invalid link id ${JSON.stringify(revokeId)} — ids are 16 lowercase hex ` +
          'characters, as printed by `just preview-link` and listed here.',
      );
    }
  } else if (arg === '--revoke-all') {
    revokeAll = true;
  } else if (arg.startsWith('-')) {
    die(`unknown flag ${arg}`);
  } else if (slug === null) {
    slug = arg;
  } else {
    die(`unexpected argument ${arg}`);
  }
}

if (!slug) {
  die('usage: npm run preview-roster -- <slug> [--revoke ID | --revoke-all] [--local]');
}
if (!SLUG_RE.test(slug)) die(`invalid slug ${JSON.stringify(slug)}`);
if (revokeId && revokeAll) die('pass either --revoke or --revoke-all, not both');

// ── revoke, then list ────────────────────────────────
//
// In that order, so the command always ends by showing the resulting state
// rather than the state you asked it to change.

try {
  if (revokeId || revokeAll) {
    revokeLinks(slug, { id: revokeId }, { local });
  }

  const rows = listLinks(slug, { local });

  if (rows.length === 0) {
    console.error(`preview-roster: no links minted for ${slug}`);
    process.exit(0);
  }

  const nowSec = Math.floor(Date.now() / 1000);
  console.log(`Preview links — ${slug} (${local ? 'local' : 'production'})\n`);
  for (const row of rows) {
    const state = row.revoked_at
      ? `revoked ${new Date(row.revoked_at).toISOString().slice(0, 10)}`
      : row.exp <= nowSec
        ? 'expired'
        : 'live';
    // A view-only link has no reviewer. Shown as a dash rather than blank so
    // the column stays readable and "who holds this?" has a visible answer.
    const who = row.reviewer ?? '—';
    const expires = new Date(row.exp * 1000).toISOString().slice(0, 16).replace('T', ' ');
    console.log(`  ${row.id}  ${who.padEnd(14)}  expires ${expires}  ${state}`);
  }
  console.log('');
  console.error(`  revoke one:  just preview-revoke ${slug} <id>`);
  console.error(`  revoke all:  just preview-revoke ${slug} --revoke-all\n`);
} catch (err) {
  die(err.message);
}
