// List and revoke the preview links minted for one post.
//
//   npm run preview-roster -- my-draft --remote                # list one post
//   npm run preview-roster -- --all --remote                   # list everything
//   npm run preview-roster -- my-draft --remote --revoke <id>   # revoke one
//   npm run preview-roster -- my-draft --remote --revoke-all    # revoke every live one
//   npm run preview-roster -- my-draft --local                  # the dev database
//
// --remote or --local is REQUIRED; see scripts/database-target.mjs.
//
// --all lists every link in the table, across all posts. Revoking stays scoped
// to one named post: a roster you can read broadly is an inventory, but a
// revoke that reached across posts would make a mistyped id withdraw someone
// else's link, which is the failure this scoping exists to prevent.
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
//
// A live link that is merely running short does not need revoking and reminting:
// `just preview-extend <slug> <id> --hours N` moves its expiry in place, and the
// URL the reviewer holds keeps working. The `extend to <date>` suffix on a row
// below is how far that can go — see scripts/preview-extend.mjs.

import { LINK_ID_RE, SLUG_RE } from '../src/lib/preview.js';
import { chooseDatabase, databaseLabel } from './database-target.mjs';
import { listAllLinks, listLinks, revokeLinks } from './links-db.mjs';

function die(message) {
  console.error(`preview-roster: ${message}`);
  process.exit(1);
}

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
let slug = null;
let local = false;
let remote = false;
let all = false;
let revokeId = null;
let revokeAll = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--local') {
    local = true;
  } else if (arg === '--remote') {
    remote = true;
  } else if (arg === '--all') {
    all = true;
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

if (all && slug) die(`pass either a slug or --all, not both (got ${JSON.stringify(slug)})`);
if (!all && !slug) {
  die(
    'usage: npm run preview-roster -- (<slug> | --all) (--remote | --local) ' +
      '[--revoke ID | --revoke-all]',
  );
}
if (slug && !SLUG_RE.test(slug)) die(`invalid slug ${JSON.stringify(slug)}`);
if (revokeId && revokeAll) die('pass either --revoke or --revoke-all, not both');
// Revoking is deliberately per-post. --all is a read: it exists so a link whose
// slug you have forgotten is still findable, not so one command can withdraw
// every link in the table.
if (all && (revokeId || revokeAll)) {
  die(
    'revoking is scoped to one post — name it instead of --all.\n' +
      '  A revoke that reached across posts would let a mistyped id withdraw\n' +
      "  another draft's link, which is exactly what the scoping prevents.\n" +
      '  Use --all to find the link, then revoke it by its own slug.',
  );
}

// Which database, decided explicitly. See scripts/database-target.mjs.
let useLocal;
try {
  useLocal = chooseDatabase({ local, remote });
} catch (err) {
  die(err.message);
}

// ── revoke, then list ────────────────────────────────
//
// In that order, so the command always ends by showing the resulting state
// rather than the state you asked it to change.

const where = databaseLabel(useLocal);

try {
  if (revokeId || revokeAll) {
    const revoked = revokeLinks(slug, { id: revokeId }, { local: useLocal });
    // Said out loud, because both no-op cases are otherwise indistinguishable
    // from success: an id that belongs to a different post is scoped away by
    // revokeLinks, and --revoke-all against a slug whose links are already
    // revoked matches nothing. Someone withdrawing a link that has gone astray
    // needs to know it is dead, not infer it from a table they have to re-read.
    if (revoked.length === 0) {
      console.error(
        revokeId
          ? `preview-roster: nothing to revoke — no live link ${revokeId} for ${slug} (${where})`
          : `preview-roster: nothing to revoke — no live links for ${slug} (${where})`,
      );
    } else {
      const what = revoked.length === 1 ? 'link' : 'links';
      console.error(`preview-roster: revoked ${revoked.length} ${what} (${revoked.join(', ')})`);
    }
  }

  const rows = all ? listAllLinks({ local: useLocal }) : listLinks(slug, { local: useLocal });

  if (rows.length === 0) {
    // Names the database. An operator who minted with --local and listed without
    // it (or the reverse) would otherwise get the most reassuring possible answer
    // from the wrong place -- and this list is the only inventory there is.
    console.error(
      all
        ? `preview-roster: no links minted for any post (${where})`
        : `preview-roster: no links minted for ${slug} (${where})`,
    );
    process.exit(0);
  }

  const nowSec = Math.floor(Date.now() / 1000);

  /** One link, as a line. Shared so both modes render identically. */
  function format(row) {
    // `expired` is no longer just a label: since migrations/0002 this is the
    // expiry isLinkActive enforces, so a row reading expired here is a link
    // already 404ing in the reviewer's browser.
    const state = row.revoked_at
      ? `revoked ${new Date(row.revoked_at).toISOString().slice(0, 10)}`
      : row.exp <= nowSec
        ? 'expired'
        : 'live';
    // A view-only link has no reviewer. Shown as a dash rather than blank so
    // the column stays readable and "who holds this?" has a visible answer.
    const who = row.reviewer ?? '—';
    const expires = new Date(row.exp * 1000).toISOString().slice(0, 16).replace('T', ' ');
    // Headroom, shown only where it is actionable. A revoked link cannot be
    // extended at all, and a row minted before ceilings existed (max_exp NULL)
    // has none -- in both cases the absence of this suffix is the answer.
    const ceiling =
      !row.revoked_at && row.max_exp != null && row.max_exp > row.exp
        ? `  · extend to ${new Date(row.max_exp * 1000).toISOString().slice(0, 10)}`
        : '';
    return `  ${row.id}  ${who.padEnd(14)}  expires ${expires}  ${state}${ceiling}`;
  }

  if (all) {
    // Grouped by post, because the question --all answers is "which draft was
    // this link for?" -- a flat list sorted by date would bury it.
    console.log(`Preview links — all posts (${where})\n`);
    let current = null;
    let live = 0;
    for (const row of rows) {
      if (row.slug !== current) {
        if (current !== null) console.log('');
        console.log(`  ${row.slug}`);
        current = row.slug;
      }
      if (!row.revoked_at && row.exp > nowSec) live++;
      console.log(format(row));
    }
    console.log('');
    const target = useLocal ? '--local' : '--remote';
    console.error(`  ${rows.length} link(s) across posts, ${live} still live`);
    console.error(`  extend:  just preview-extend <slug> <id> --hours N ${target}`);
    console.error(`  revoke:  just preview-revoke <slug> <id> ${target}\n`);
  } else {
    console.log(`Preview links — ${slug} (${where})\n`);
    for (const row of rows) console.log(format(row));
    console.log('');
    const target = useLocal ? '--local' : '--remote';
    console.error(`  extend one:  just preview-extend ${slug} <id> --hours N ${target}`);
    console.error(`  revoke one:  just preview-revoke ${slug} <id> ${target}`);
    console.error(`  revoke all:  just preview-revoke ${slug} --revoke-all ${target}\n`);
  }
} catch (err) {
  die(err.message);
}
