// List and revoke the preview links minted for one post.
//
//   npm run preview-roster -- --remote                          # every post
//   npm run preview-roster -- my-draft --remote                 # one post
//   npm run preview-roster -- --revoke <id> --remote            # withdraw one
//   npm run preview-roster -- my-draft --revoke <id> --remote   # post asserted
//   npm run preview-roster -- my-draft --revoke-all --remote    # withdraw all for a post
//   npm run preview-roster -- my-draft --local                  # the dev database
//
// --remote or --local is REQUIRED; see scripts/database-target.mjs.
//
// NO SLUG LISTS EVERY LINK, across all posts. That is a read, and the per-post
// scoping that matters elsewhere does not reach a CLI already authenticated as
// you -- an inventory you can only query by knowing the answer is not much of an
// inventory. `--all` is kept as an alias for what the absent slug now says, and
// is refused next to anything that names a post: it is a synonym, not a modifier.
//
// Revoking still resolves to exactly one post: --revoke takes an id and derives
// the post from its row, --revoke-all takes a slug. Neither can reach the table
// at large. A slug in front of --revoke's id is an ASSERTION -- if it disagrees
// with the row, this refuses and names both posts. See scripts/resolve-id.mjs.
//
// Reads and writes D1 through `wrangler d1 execute`, which is already
// authenticated as you. That is why there is no admin WRITE endpoint: the
// deployed worker never needs a way to mutate a link, and handing someone one
// draft must not hand them the rest.
//
// The Desk at /admin does now READ this same table — see CLAUDE.md, "The Desk"
// — behind Cloudflare Access and a JWT the worker verifies itself. It shows the
// same four states this command prints, from the same src/lib/link-state.js, so
// the two cannot disagree about what is outstanding. It cannot revoke anything.
//
// This list is the ONLY inventory. A token is recorded nowhere else, so a link
// missing from here cannot be revoked, only waited out.
//
// Revoking sets revoked_at; rows are never deleted, so a withdrawn link stays
// listed rather than vanishing. It removes READING as well as writing — the
// post 404s for that link.
//
// A live link that is merely running short does not need revoking and reminting:
// `just preview-extend <id> --hours N` moves its expiry in place, and the
// URL the reviewer holds keeps working. The `extend to <date>` suffix on a row
// below is how far that can go — see scripts/preview-extend.mjs.
//
// A link whose POST HAS PUBLISHED reads `spent`, not `live`. Its row may not have
// expired, but the draft it was minted to show is public and it grants nothing a
// plain URL doesn't. Nothing needs doing about a spent link; the label exists so
// the roster's answer to "what is outstanding?" stays true.

import { linkState } from '../src/lib/link-state.js';
import { LINK_ID_RE, SLUG_RE } from '../src/lib/preview.js';
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
    // Retained as an alias: listing every post is what no slug means now. Kept
    // so `npm run preview-roster -- --all` out of shell history still works —
    // but refused below next to a slug or a revoke, where it would once have
    // been a modifier and would now silently widen the answer.
    all = true;
  } else if (arg === '--revoke') {
    // A BOOLEAN, with the id as a positional. It used to take its value inline,
    // and that is what forced the justfile to rewrite arguments: `just` fills
    // positional parameters greedily, so no conditional there could tell
    // `preview-revoke <id> --remote` from `preview-revoke <slug> <id>`.
    revoke = true;
  } else if (arg === '--revoke-all') {
    revokeAll = true;
  } else if (arg.startsWith('-')) {
    die(`unknown flag ${arg}`);
  } else {
    positional.push(arg);
  }
}

// WHAT THE POSITIONALS MEAN, on the same rule as preview-extend.mjs:
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
// `--all` now says exactly what an absent slug says, so pairing it with
// something that names a post is a contradiction rather than a refinement. The
// slug-scoped form used to be refused outright and still is: an inventory that
// silently answers a wider question than it was asked is the most reassuring
// possible wrong answer, and this list is the only inventory there is.
if (all && (revoke || revokeAll)) {
  die('--all lists; it does not revoke — use --revoke <link-id> or --revoke-all <slug>');
}
if (all && slug !== null) {
  die(`--all lists every post — drop the slug to mean that, or drop --all to list ${slug}`);
}
// Revoking one link resolves to a post; revoking in bulk has to be told one.
// Neither can reach the whole table, which is the scoping that matters -- see
// the header, and scripts/resolve-id.mjs on where the per-id check lives now.
if (revokeAll && slug === null) {
  die(
    '--revoke-all needs the post to revoke for.\n' +
      '  It is the one revoke with no id to resolve through, so it cannot derive one.\n' +
      '  `npm run preview-roster --` with no slug lists every link across every post.',
  );
}

// No slug and no revoke is the whole table. `--all` said this before and is kept
// as an alias; the absence of a slug says it now. The guards above have already
// refused every way the two could disagree, so this reads either one.
const listAll = !revoke && !revokeAll && slug === null;

// Which database, decided explicitly. See scripts/database-target.mjs.
const useLocal = resolveDatabase({ local, remote });

// ── revoke, then list ────────────────────────────────
//
// In that order, so the command always ends by showing the resulting state
// rather than the state you asked it to change.

const where = databaseLabel(useLocal);

try {
  // Branch on the FLAG, not on the id it collected: `--revoke ''` is an empty
  // string, which is falsy, and would otherwise skip the revoke entirely and
  // fall through to a listing that dies on a null slug. Resolution refuses the
  // shape and says so.
  if (revoke || revokeAll) {
    // The post comes off the row. revokeLinks still scopes its UPDATE by slug --
    // see scripts/resolve-id.mjs on why that clause is no longer what protects a
    // mistyped id, and why it stays anyway.
    let resolved = null;
    if (revoke) {
      resolved = await resolveLink(die, revokeId, { slug, local: useLocal });
      ({ slug } = resolved);
    }
    const revoked = await revokeLinks(slug, { id: revokeId }, { local: useLocal });
    // Said out loud, because a no-op is otherwise indistinguishable from success,
    // and someone withdrawing a link that has gone astray needs to know it is
    // dead rather than infer it from a table they have to re-read.
    //
    // On the id path there is now exactly ONE cause left: the link was already
    // revoked. No such link and wrong post are both settled by resolveLink
    // before the UPDATE runs, so this can name the date instead of listing the
    // possibilities -- and the row saying so is already in hand.
    if (revoked.length === 0) {
      const revokedAt = resolved?.row?.revoked_at;
      console.error(
        revoke
          ? `preview-roster: nothing to revoke — link ${revokeId} for ${slug} was already revoked` +
              `${revokedAt ? ` on ${new Date(revokedAt).toISOString().slice(0, 10)}` : ''} (${where})`
          : `preview-roster: nothing to revoke — no live links for ${slug} (${where})`,
      );
    } else {
      const what = revoked.length === 1 ? 'link' : 'links';
      console.error(`preview-roster: revoked ${revoked.length} ${what} (${revoked.join(', ')})`);
    }
  }

  const rows = listAll
    ? await listAllLinks({ local: useLocal })
    : await listLinks(slug, { local: useLocal });

  if (rows.length === 0) {
    // Names the database. An operator who minted with --local and listed without
    // it (or the reverse) would otherwise get the most reassuring possible answer
    // from the wrong place -- and this list is the only inventory there is.
    console.error(
      listAll
        ? `preview-roster: no links minted for any post (${where})`
        : `preview-roster: no links minted for ${slug} (${where})`,
    );
    process.exit(0);
  }

  // One instant for the whole listing, so a row cannot be classified against a
  // later clock than the row above it.
  const now = Date.now();

  // When each post goes live, read once per slug from its own frontmatter. A
  // published post ends its links: the draft they were minted to show is public,
  // so they grant nothing a plain URL doesn't. Reporting those as `live` is what
  // made the roster answer "what is outstanding?" with "everything, forever".
  //
  // Tolerant of a missing or unreadable post, and deliberately so. This list is
  // the only inventory of issued links there is, and a link minted against a
  // post since renamed or deleted is exactly the one you most need to see in
  // order to revoke it — failing the whole listing over it would be the wrong
  // trade. Such a row simply shows its own expiry, as before.
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

  /** Just the date, for the two labels that carry one. */
  const day = (date) => date.toISOString().slice(0, 10);

  /**
   * One link, as a line. Shared so both modes render identically.
   *
   * The CLASSIFICATION is src/lib/link-state.js, which the Desk at /admin reads
   * too — two derivations of "live" is how a roster and a dashboard start
   * disagreeing about what is outstanding. What stays here is the presentation:
   * the column widths, the dash for a view-only link, and the `· extend to`
   * suffix.
   *
   * `expired` is not just a label: since migrations/0002 this is the expiry
   * isLinkActive enforces, so a row reading expired here is a link already
   * 404ing in the reviewer's browser. `spent` is the same idea one step on —
   * the row may not have expired, but the post it guarded is public.
   */
  function format(row) {
    const info = linkState(row, { pubDate: publicationOf(row.slug), now });
    const state =
      info.state === 'revoked'
        ? `revoked ${day(info.revokedAt)}`
        : info.state === 'spent'
          ? `spent (published ${day(info.publishedAt)})`
          : info.state;
    // A view-only link has no reviewer. Shown as a dash rather than blank so
    // the column stays readable and "who holds this?" has a visible answer.
    const who = row.reviewer ?? '—';
    const expires = info.expires.toISOString().slice(0, 16).replace('T', ' ');
    // Headroom, shown only where it is actionable — linkState returns null for
    // every case where extending would do nothing, and the absence of this
    // suffix is the answer.
    const ceiling = info.extendTo ? `  · extend to ${day(info.extendTo)}` : '';
    return `  ${row.id}  ${who.padEnd(14)}  expires ${expires}  ${state}${ceiling}`;
  }

  if (listAll) {
    // Grouped by post, because the question an unscoped listing answers is
    // "which draft was this link for?" -- a flat list by date would bury it.
    console.log(`Preview links — all posts (${where})\n`);
    let current = null;
    let live = 0;
    for (const row of rows) {
      if (row.slug !== current) {
        if (current !== null) console.log('');
        console.log(`  ${row.slug}`);
        current = row.slug;
      }
      // "Still live" excludes spent rows for the same reason format() labels
      // them differently: a link to a post that is already public is not
      // outstanding in any sense that matters. Read from the same classifier
      // format() uses, so the tally and the lines below it cannot disagree.
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
