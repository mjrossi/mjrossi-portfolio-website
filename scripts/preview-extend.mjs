// Move the expiry of a preview link that already exists.
//
//   npm run preview-extend -- my-draft a1b2c3d4e5f60718 --remote
//   npm run preview-extend -- my-draft a1b2c3d4e5f60718 --remote --hours 96
//   npm run preview-extend -- my-draft a1b2c3d4e5f60718 --local
//
// --remote or --local is REQUIRED; see scripts/database-target.mjs.
//
// THE URL DOES NOT CHANGE. That is the entire point of this command: there is
// nothing to re-send, and the reviewer never learns their link was about to
// lapse. Before it existed, "give them another two days" meant minting a second
// link, sending a second URL, and leaving the first one live until it expired.
//
// It works because the expiry a request is judged against is not the one inside
// the signature (migrations/0002):
//
//   preview_links.exp -- THE CLOCK, checked by isLinkActive on every request.
//                        This is what moves.
//   the token's exp   -- THE CAP. Signed, immutable, and therefore unreachable
//                        from here: the furthest that clock can ever be wound,
//                        whatever the row says.
//
// --hours is a NEW WINDOW MEASURED FROM NOW, not time added to what is left.
// Same reading as `just preview-link --hours`, and it means this command
// shortens as readily as it extends -- `--hours 1` on a link with three days
// left is the gentler alternative to revoking outright.
//
// Refusals are specific on purpose. An UPDATE that changes nothing looks
// identical for a link that never existed, one that belongs to another post,
// one already revoked, and one asking for more time than its signature will
// ever honour. Extending is what you do when somebody is waiting, so "nothing
// happened" is not a usable answer.

import { LINK_ID_RE, SLUG_RE } from '../src/lib/preview.js';
import { chooseDatabase, databaseLabel } from './database-target.mjs';
import { extendLink, getLink } from './links-db.mjs';

const DEFAULT_HOURS = 48;

function die(message) {
  console.error(`preview-extend: ${message}`);
  process.exit(1);
}

/** Epoch seconds → the ISO form used by preview-link's own output. */
function iso(sec) {
  return new Date(sec * 1000).toISOString();
}

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
let slug = null;
let id = null;
let hours = DEFAULT_HOURS;
let local = false;
let remote = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--local') {
    local = true;
  } else if (arg === '--remote') {
    remote = true;
  } else if (arg === '--hours') {
    hours = Number(argv[++i]);
    // Same rule as minting: > 0, not >= 0. `--hours 0` would set an expiry that
    // has already passed, which is a revoke wearing the wrong name -- and one
    // that leaves the row reading `live` in nobody's mental model but SQLite's.
    // Use `just preview-revoke` to take a link back.
    if (!Number.isFinite(hours) || hours <= 0) {
      die('--hours must be a positive number (to take a link back, use just preview-revoke)');
    }
  } else if (arg.startsWith('-')) {
    die(`unknown flag ${arg}`);
  } else if (slug === null) {
    slug = arg;
  } else if (id === null) {
    id = arg;
  } else {
    die(`unexpected argument ${arg}`);
  }
}

if (!slug || !id) {
  die('usage: npm run preview-extend -- <slug> <link-id> (--remote | --local) [--hours N]');
}
if (!SLUG_RE.test(slug)) die(`invalid slug ${JSON.stringify(slug)}`);
// Checked here as well as in links-db so the message names the constraint
// rather than surfacing a validation error from two modules down.
if (!LINK_ID_RE.test(id)) {
  die(
    `invalid link id ${JSON.stringify(id)} — ids are 16 lowercase hex characters, ` +
      'as printed by `just preview-link` and listed by `just preview-roster`.',
  );
}

// Which database, decided explicitly. See scripts/database-target.mjs for why
// there is no default: extending the wrong one reports success while the link
// the reviewer holds goes on expiring.
let useLocal;
try {
  useLocal = chooseDatabase({ local, remote });
} catch (err) {
  die(err.message);
}

const where = databaseLabel(useLocal);

// ── extend ───────────────────────────────────────────

const exp = Math.floor(Date.now() / 1000) + Math.round(hours * 3600);

let changed;
try {
  // The ceiling is enforced inside this statement, not here -- see extendLink.
  changed = extendLink(slug, id, exp, { local: useLocal });
} catch (err) {
  die(err.message);
}

if (changed.length === 0) {
  // Nothing moved. Read the row back to say which of the several silent reasons
  // applied; this is the only thing getLink is for.
  let row;
  try {
    row = getLink(slug, id, { local: useLocal });
  } catch (err) {
    die(err.message);
  }

  if (!row) {
    die(
      `no link ${id} for ${slug} in the ${where} database.\n` +
        `  Links are scoped to their own post, so an id belonging to another draft reads\n` +
        '  as missing here. `just preview-roster-all ' +
        `${useLocal ? '--local' : '--remote'}` +
        '` lists every link across every post.',
    );
  }
  if (row.revoked_at) {
    die(
      `link ${id} was revoked on ${new Date(row.revoked_at).toISOString().slice(0, 10)} ` +
        `(${where}).\n  Revoking is final — mint a fresh link with just preview-link instead.`,
    );
  }
  if (exp > row.max_exp) {
    die(
      `${hours}h would run to ${iso(exp)}, past the ceiling this link was signed with ` +
        `(${iso(row.max_exp)}).\n` +
        '  The ceiling is inside the signature and cannot be moved from here — that is what\n' +
        '  stops an extendable link from becoming a permanent one. Mint a fresh link, or\n' +
        `  extend to at most ${iso(row.max_exp)}.`,
    );
  }
  // Nothing above explains it. Say so rather than blaming the ceiling, which is
  // the one reason we have just ruled out.
  die(
    `the update matched no row for ${id} (${where}), and the row itself looks extendable.\n` +
      '  Re-run just preview-roster ' +
      `${slug} ${useLocal ? '--local' : '--remote'}` +
      ' to see its current state.',
  );
}

// ── report ───────────────────────────────────────────
//
// Everything goes to stderr and stdout stays empty, which is the opposite of
// `just preview-link` and deliberate. Minting produces an artifact — the URL —
// and puts it on stdout so it pipes. Extending produces nothing to hand over;
// printing the URL anyway would invite re-sending a link that never changed.

const row = changed[0];
const headroom = row.max_exp > row.exp ? iso(row.max_exp) : null;

console.error(`preview-extend: ${slug} ${row.id} now expires ${iso(row.exp)} (${where})\n`);
console.error(`  database: ${where}`);
console.error(`  post:     ${slug}`);
console.error(`  link id:  ${row.id}`);
console.error(`  expires:  ${iso(row.exp)} (${hours}h from now)`);
console.error(
  headroom
    ? `  ceiling:  ${headroom} — the furthest this link can ever be extended`
    : '  ceiling:  reached — this link cannot be extended again; mint a new one',
);
console.error('  link:     unchanged — the URL the reviewer already has keeps working\n');
