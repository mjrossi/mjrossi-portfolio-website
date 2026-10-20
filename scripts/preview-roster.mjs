// List and revoke preview links.
//
//   npm run preview-roster -- --remote                          # every post
//   npm run preview-roster -- my-draft --remote                 # one post
//   npm run preview-roster -- --revoke <id> --remote            # withdraw one
//   npm run preview-roster -- my-draft --revoke <id> --remote   # post asserted
//   npm run preview-roster -- my-draft --revoke-all --remote    # withdraw all for a post
//   npm run preview-roster -- my-draft --local                  # the dev database
//
// --remote or --local is REQUIRED (database-target.mjs).
//
// THIS IS THE ONLY INVENTORY: a token is recorded nowhere else, so a link
// missing from here can't be revoked, only waited out. No slug lists every post
// — per-post scoping matters in the public worker, not in a CLI authenticated
// as you. `--all` is an alias for that, refused beside anything naming a post.
//
// Revoking always resolves to one post (--revoke derives it from the id's row;
// --revoke-all takes a slug). It sets revoked_at, never deletes, and takes away
// READING too: the post 404s for that link. There is no admin write endpoint;
// the Desk only reads, with the same link-state.js classification.
//
// A link running short wants `just preview-extend`, not a re-mint. `spent`
// means the row is fine but the post is public: nothing to do.

import { isoDay } from '../src/lib/galley-render.js';
import { linkState } from '../src/lib/link-state.js';
import { SLUG_RE } from '../src/lib/preview.js';
import { readPubDate } from './content.mjs';
import { cli } from './cli.mjs';
import { databaseLabel } from './database-target.mjs';
import { listAllLinks, listLinks, revokeLinks } from './links-db.mjs';
import { resolveLink } from './resolve-id.mjs';

const { die, resolveDatabase } = cli('preview-roster');

// ── args ─────────────────────────────────────────────

const argv = process.argv.slice(2);
const positional = [];
let slug = null;
let local = false;
let remote = false;
let all = false;
let revoke = false;
let revokeAll = false;

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === '--local') {
    local = true;
  } else if (arg === '--remote') {
    remote = true;
  } else if (arg === '--all') {
    // An ASSERTION that no post was named, not a mode: only the guards read it.
    // Wiring it back into `listAll` let it beat a slug and silently widen the
    // answer. Checked after the loop so `--all x` and `x --all` agree.
    all = true;
  } else if (arg === '--revoke') {
    // A boolean with the id as a positional, so the justfile can pass
    // arguments through (just fills positionals greedily).
    revoke = true;
  } else if (arg === '--revoke-all') {
    revokeAll = true;
  } else if (arg.startsWith('-')) {
    die(`unknown flag ${arg}`);
  } else {
    positional.push(arg);
  }
}

// The positionals, on preview-extend.mjs's rule:
//
//   --revoke      <id>            withdraw one link; the post comes off the row
//   --revoke      <slug> <id>     the same, with the post asserted
//   --revoke-all  <slug>          withdraw every live link for that post
//   (default)     <slug>          list one post
//   (default)     —               list EVERY post
let revokeId = null;

if (revoke) {
  if (positional.length === 1) {
    [revokeId] = positional;
  } else if (positional.length === 2) {
    [slug, revokeId] = positional;
  } else {
    die(
      'usage: npm run preview-roster -- --revoke (<link-id> | <slug> <link-id>) (--remote | --local)',
    );
  }
} else {
  if (positional.length > 1) die(`unexpected argument ${positional[1]}`);
  slug = positional[0] ?? null;
}

if (slug !== null && !SLUG_RE.test(slug)) die(`invalid slug ${JSON.stringify(slug)}`);
if (revoke && revokeAll) die('pass either --revoke or --revoke-all, not both');
// `--all` beside a post is a contradiction. A list that silently answers a
// wider question than asked is the most reassuring wrong answer there is.
if (all && (revoke || revokeAll)) {
  die('--all lists; it does not revoke — use --revoke <link-id> or --revoke-all <slug>');
}
if (all && slug !== null) {
  die(`--all lists every post — drop the slug to mean that, or drop --all to list ${slug}`);
}
if (revokeAll && slug === null) {
  die(
    '--revoke-all needs the post to revoke for.\n' +
      '  It is the one revoke with no id to resolve through, so it cannot derive one.\n' +
      '  `npm run preview-roster --` with no slug lists every link across every post.',
  );
}

const listAll = !revoke && !revokeAll && slug === null;

const useLocal = resolveDatabase({ local, remote });

// ── revoke, then list ────────────────────────────────
//
// In that order, so the command ends by showing the resulting state.

const where = databaseLabel(useLocal);

/**
 * A link's state as a clause, to explain a no-op. Reads the classification
 * rather than assuming "revoked", so narrowing revokeLinks later can't make it lie.
 */
const describe = (info) =>
  info.state === 'revoked' ? `already revoked on ${isoDay(info.revokedAt)}` : info.state;

try {
  // The FLAG, not the id: `--revoke ''` is falsy and would fall through to listing.
  if (revoke || revokeAll) {
    let resolved = null;
    if (revoke) {
      resolved = await resolveLink(die, revokeId, { slug, local: useLocal });
      ({ slug } = resolved);
    }
    const revoked = await revokeLinks(slug, { id: revokeId }, { local: useLocal });
    // Said out loud: a no-op otherwise looks like success. On the id path the
    // only cause left is "already revoked"; resolveLink settled the rest.
    if (revoked.length === 0) {
      // Read the row rather than assume the cause, via the same classifier as
      // the rows below and the Desk.
      const why = revoke
        ? `link ${revokeId} for ${slug} is ${describe(linkState(resolved.row))}`
        : `no live links for ${slug}`;
      console.error(`preview-roster: nothing to revoke — ${why} (${where})`);
    } else {
      const what = revoked.length === 1 ? 'link' : 'links';
      console.error(`preview-roster: revoked ${revoked.length} ${what} (${revoked.join(', ')})`);
    }
  }

  const rows = listAll
    ? await listAllLinks({ local: useLocal })
    : await listLinks(slug, { local: useLocal });

  if (rows.length === 0) {
    // Names the database: the wrong one gives the most reassuring answer.
    console.error(
      listAll
        ? `preview-roster: no links minted for any post (${where})`
        : `preview-roster: no links minted for ${slug} (${where})`,
    );
    process.exit(0);
  }

  // One instant for the whole listing.
  const now = Date.now();

  // pubDate per slug, so links on a public post read `spent`. A missing post
  // is tolerated: a link for a renamed or deleted post is the one you most need
  // to see to revoke it.
  const pubDates = new Map();
  function publicationOf(slug) {
    if (!pubDates.has(slug)) {
      try {
        pubDates.set(slug, readPubDate(slug));
      } catch {
        pubDates.set(slug, null);
      }
    }
    return pubDates.get(slug);
  }

  /**
   * One link, as a line. The classification is link-state.js; this is only the
   * presentation. `expired` here means already 404ing for the reviewer.
   */
  function format(row) {
    const info = linkState(row, { pubDate: publicationOf(row.slug), now });
    const state =
      info.state === 'revoked'
        ? `revoked ${isoDay(info.revokedAt)}`
        : info.state === 'spent'
          ? `spent (published ${isoDay(info.publishedAt)})`
          : info.state;
    // A dash for view-only, so "who holds this?" has a visible answer.
    const who = row.reviewer ?? '—';
    const expires = info.expires.toISOString().slice(0, 16).replace('T', ' ');
    // Only where extending would do something.
    const ceiling = info.extendTo ? `  · extend to ${isoDay(info.extendTo)}` : '';
    return `  ${row.id}  ${who.padEnd(14)}  expires ${expires}  ${state}${ceiling}`;
  }

  if (listAll) {
    // Grouped by post: an unscoped listing answers "which draft was this for?"
    console.log(`Preview links — all posts (${where})\n`);
    let current = null;
    let live = 0;
    for (const row of rows) {
      if (row.slug !== current) {
        if (current !== null) console.log('');
        console.log(`  ${row.slug}`);
        current = row.slug;
      }
      // Spent rows excluded, by the same classifier as the lines below.
      if (linkState(row, { pubDate: publicationOf(row.slug), now }).live) live++;
      console.log(format(row));
    }
    console.log('');
    const target = useLocal ? '--local' : '--remote';
    console.error(`  ${rows.length} link(s) across posts, ${live} still live`);
    console.error(`  extend:  just preview-extend <id> --hours N ${target}`);
    console.error(`  revoke:  just preview-revoke <id> ${target}\n`);
  } else {
    console.log(`Preview links — ${slug} (${where})\n`);
    for (const row of rows) console.log(format(row));
    console.log('');
    const target = useLocal ? '--local' : '--remote';
    console.error(`  extend one:  just preview-extend <id> --hours N ${target}`);
    console.error(`  revoke one:  just preview-revoke <id> ${target}`);
    console.error(`  revoke all:  just preview-revoke-all ${slug} ${target}\n`);
  }
} catch (err) {
  die(err.message);
}
