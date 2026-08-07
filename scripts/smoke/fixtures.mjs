// The preview_links fixtures, and the one place links-db's SQL runs under test.
//
// All of this happens BEFORE wrangler dev is spawned, and it has to. wrangler dev
// reads the persisted SQLite once at startup and does not flush its own writes
// back, so a row inserted mid-run would not be seen by the running worker —
// which is also why the revoked cases are seeded already-revoked rather than by
// revoking partway through. That tests enforcement, which is the part that
// matters, without a second process writing the database underneath the first.
//
// Local only throughout; none of this can touch the production database.
import { check } from './check.mjs';
import {
  EXTEND_SLUG,
  FAR_FUTURE_EXP,
  FIXTURE_REVISION,
  FIXTURE_SLUG,
  NOW_SEC,
  OTHER_SLUG,
  PUBLISHED_SLUG,
  SMOKE_REVIEWER,
  SMOKE_REVIEWER_TWO,
  STALE_REVISION,
} from './config.mjs';
import { d1Migrate } from '../d1.mjs';
import { clearLinks, extendLink, extendLinks, getLink, recordLinks } from '../links-db.mjs';
import { clearNotes, closeNotes, listNotes, reopenNote, seedNotes } from '../notes-db.mjs';

const LOCAL = { local: true };

// Every token the live matrices sign needs a row here, because middleware
// refuses a grant whose link is not in the allowlist. One row per token rather
// than a shared one: each assertion is named for the thing it isolates —
// expiry, slug scoping, reviewer scoping — and sharing a row would let one
// test's revocation break another's stated reason for failing.
//
// Ids are fixed rather than random so a row and the token signed against it
// cannot drift apart. The row, the id and the reason it exists live together in
// this table; nothing else needs to know the ids.
//
// Seeded through recordLinks, the same function production mints through, so a
// schema change that breaks minting breaks this fixture in the same commit
// rather than leaving a green suite pointed at a table nothing writes any more.
export const LINKS = {
  /** The view-only fixture link — the plain positive path. */
  view: { id: 'aaaa0000bbbb1111', slug: FIXTURE_SLUG, reviewer: null, exp: FAR_FUTURE_EXP },
  /** View-only, minted for another post: a valid token at the wrong URL. */
  wrongSlug: { id: 'bbbb1111cccc2222', slug: OTHER_SLUG, reviewer: null, exp: FAR_FUTURE_EXP },
  /** Live row under a deliberately expired TOKEN, so that check fails for its named reason. */
  expiredToken: { id: 'cccc2222dddd3333', slug: FIXTURE_SLUG, reviewer: null, exp: FAR_FUTURE_EXP },
  /**
   * The mirror image: an expired ROW under a token that is still perfectly
   * valid, with a far-future ceiling so the signature cannot be what refuses
   * it. The only proof that the row half of the expiry is wired up at all —
   * every other row is far-future, so dropping isLinkActive's `exp` comparison
   * would silently promote every link to its full ceiling with the suite green.
   */
  expiredRow: {
    id: '1111aaaa2222bbbb',
    slug: FIXTURE_SLUG,
    reviewer: null,
    exp: NOW_SEC - 60,
    maxExp: FAR_FUTURE_EXP,
  },
  /** The working review link. */
  review: { id: 'dddd3333eeee4444', slug: FIXTURE_SLUG, reviewer: SMOKE_REVIEWER, exp: FAR_FUTURE_EXP },
  /** Review link for another post — read at a far-future expiry by the --all scoping check. */
  crossSlug: { id: 'eeee4444ffff5555', slug: OTHER_SLUG, reviewer: SMOKE_REVIEWER, exp: FAR_FUTURE_EXP },
  /** extendLink's own round-trip. One hour of headroom, so "at the ceiling" and "one second past" are both reachable. */
  extendProbe: {
    id: '3333cccc4444dddd',
    slug: EXTEND_SLUG,
    reviewer: null,
    exp: NOW_SEC + 3600,
    maxExp: NOW_SEC + 7200,
  },
  /** Revoked, but with headroom left — revoking has to beat available ceiling. */
  extendRevoked: {
    id: '5555eeee6666ffff',
    slug: EXTEND_SLUG,
    reviewer: null,
    exp: NOW_SEC + 3600,
    maxExp: NOW_SEC + 7200,
    revokedAt: Date.now(),
  },
  /** --all: ceiling reaches the new date. Differs from the next row ONLY in headroom. */
  extendAllRoom: {
    id: '7777aaaa8888bbbb',
    slug: EXTEND_SLUG,
    reviewer: null,
    exp: NOW_SEC + 3600,
    maxExp: NOW_SEC + 100_000,
  },
  /** --all: ceiling falls short — what "mint a fresh link" looks like after a big slip. */
  extendAllStuck: {
    id: '9999cccc0000dddd',
    slug: EXTEND_SLUG,
    reviewer: null,
    exp: NOW_SEC + 3600,
    maxExp: NOW_SEC + 3600,
  },
  /** Live review link on a post that has ALREADY published: everything passes except the post being a draft. */
  published: { id: '2222eeee3333ffff', slug: PUBLISHED_SLUG, reviewer: SMOKE_REVIEWER, exp: FAR_FUTURE_EXP },
  /** Seeded already revoked. */
  revoked: {
    id: 'ffff5555aaaa6666',
    slug: FIXTURE_SLUG,
    reviewer: SMOKE_REVIEWER,
    exp: FAR_FUTURE_EXP,
    revokedAt: Date.now(),
  },
};

// The allowlist's own negative case, and the one id that is NOT in the table
// above: a well-signed token for a row that was never written. It is defined by
// its absence, so it must stay out of anything that seeds LINKS wholesale.
export const UNRECORDED_LINK_ID = '99998888aaaabbbb';

// Every slug this file writes rows for. Used by both cleanups, which have to
// stay identical or a fixture outlives the run that made it.
const FIXTURE_SLUGS = [FIXTURE_SLUG, OTHER_SLUG, EXTEND_SLUG, PUBLISHED_SLUG];

/**
 * wrangler dev does NOT apply migrations on startup — it just hands the worker
 * an empty database. Without this the galley and allowlist assertions fail with
 * "no such table", which reads like a broken endpoint rather than an unmigrated
 * fixture.
 */
export function migrateLocalDb() {
  d1Migrate(LOCAL);
}

/**
 * Clear this suite's own rows. The rate-limit assertion deliberately fills the
 * hourly write quota, so if those rows survived to the next run the FIRST write
 * of that run would come back 429 — a confusing failure whose cause is an hour
 * old.
 *
 * Today they don't: rows written through `wrangler dev` are not flushed back to
 * the local database file when smoke kills the process, so each run starts empty
 * in practice. That is observed wrangler behaviour, not a contract, so the suite
 * does not depend on it.
 *
 * Scoped to SMOKE_REVIEWER and to FIXTURE_SLUGS, so it can only touch rows this
 * suite wrote — with one caveat: PUBLISHED_SLUG is a real post, so this does
 * clear any local preview links you minted for it by hand. Local only
 * (clearLinks refuses --remote), and the alternative is a fixed fixture id
 * colliding with itself on the second run.
 */
export function clearFixtures() {
  for (const reviewer of [SMOKE_REVIEWER, SMOKE_REVIEWER_TWO]) {
    clearNotes(FIXTURE_SLUGS, { reviewer }, LOCAL);
  }
  clearLinks(FIXTURE_SLUGS, LOCAL);
}

export function seedLinks() {
  recordLinks(Object.values(LINKS), LOCAL);
}

// The three states a note can be in by the time a second review round starts.
// Seeded rather than written through the endpoint because two of them are
// unreachable on demand: /api/galley refuses a note from a stale page (that is
// the point of the stale_page check), and closing is a CLI act.
//
// Anchored on a range no real block carries, so a marker placed for one of these
// would have to be a bug rather than a coincidence.
export const NOTES = {
  /**
   * Open, and written against the file as it is on disk. The plain positive
   * path: this is the one the margin may anchor.
   */
  current: {
    id: '11111111-1111-4111-8111-111111111111',
    slug: FIXTURE_SLUG,
    revisionHash: FIXTURE_REVISION,
    reviewer: SMOKE_REVIEWER,
    srcStart: 11,
    srcEnd: 12,
    quote: 'smoke current note quote',
    body: 'smoke: open note against the current revision',
  },
  /**
   * Open, written against a revision that is gone — and by a DIFFERENT reviewer,
   * which is what makes the cross-reviewer read assertable at all. Its anchor
   * must never reach the page: those line numbers now describe other prose.
   */
  stale: {
    id: '22222222-2222-4222-8222-222222222222',
    slug: FIXTURE_SLUG,
    revisionHash: STALE_REVISION,
    reviewer: SMOKE_REVIEWER_TWO,
    srcStart: 13,
    srcEnd: 14,
    quote: 'smoke stale note quote',
    body: 'smoke: open note against an older revision',
  },
  /**
   * Closed: a round the author finished with. Must not appear among the open
   * notes, must still be readable under "addressed", and must never be anchored.
   */
  closed: {
    id: '33333333-3333-4333-8333-333333333333',
    slug: FIXTURE_SLUG,
    revisionHash: STALE_REVISION,
    reviewer: SMOKE_REVIEWER,
    srcStart: 15,
    srcEnd: 16,
    quote: 'smoke closed note quote',
    body: 'smoke: note from a closed round',
    closedAt: Date.now(),
  },
};

/** Its own step, because the close/reopen round-trip below mutates these rows. */
export function seedNotesFixtures() {
  seedNotes(Object.values(NOTES), LOCAL);
}

/**
 * The extendLink round-trip, run before the worker is even up.
 *
 * This is the only place links-db's SQL actually executes under test. The
 * module imports cleanly, but every function in it shells out to `wrangler d1
 * execute` when CALLED, so running the SQL needs a migrated local database —
 * which smoke has and `node --test` does not. The ceiling clause is
 * the whole safety property of `just preview-extend` — without it an extendable
 * link becomes a permanent one — and it lives in a WHERE clause, where a typo
 * is silent and reads as "extended successfully".
 */
export function checkExtendRoundTrip() {
  const ceiling = NOW_SEC + 7200;
  const probe = LINKS.extendProbe.id;

  const extended = extendLink(EXTEND_SLUG, probe, ceiling, LOCAL);
  check(
    'extend: moves the expiry up to the ceiling',
    extended.length === 1 && extended[0].exp === ceiling,
    `got ${JSON.stringify(extended)}`,
  );

  const tooFar = extendLink(EXTEND_SLUG, probe, ceiling + 1, LOCAL);
  check(
    'extend: one second past the ceiling changes nothing',
    tooFar.length === 0,
    `got ${JSON.stringify(tooFar)} — the signed ceiling is not being enforced`,
  );
  check(
    'extend: a refused extension leaves the old expiry in place',
    getLink(EXTEND_SLUG, probe, LOCAL)?.exp === ceiling,
    'the row moved despite the UPDATE reporting no change',
  );

  const wrongPost = extendLink(FIXTURE_SLUG, probe, ceiling, LOCAL);
  check(
    'extend: an id belonging to another post changes nothing',
    wrongPost.length === 0,
    `got ${JSON.stringify(wrongPost)} — extending is not scoped to the named post`,
  );

  const revoked = extendLink(EXTEND_SLUG, LINKS.extendRevoked.id, ceiling, LOCAL);
  check(
    'extend: a revoked link cannot be extended back to life',
    revoked.length === 0,
    `got ${JSON.stringify(revoked)} — revoking is supposed to be final`,
  );

  // `just preview-extend <slug> --all`, the command for "I pushed the date out".
  // One statement over every live link for a post, with the SAME ceiling clause:
  // a partial result is the expected outcome, not an error, so it has to be
  // visible in what comes back or the caller cannot name the links it missed.
  const target = NOW_SEC + 50_000;
  const movedIds = extendLinks(EXTEND_SLUG, target, LOCAL).map((row) => row.id);
  check(
    'extend --all: moves every live link whose ceiling reaches the new date',
    movedIds.includes(LINKS.extendAllRoom.id),
    `moved ${JSON.stringify(movedIds)} — a link with headroom was left behind`,
  );
  check(
    'extend --all: leaves a link whose ceiling falls short',
    !movedIds.includes(LINKS.extendAllStuck.id),
    'a link was extended past the ceiling it was signed with',
  );
  check(
    'extend --all: does not touch a revoked link',
    !movedIds.includes(LINKS.extendRevoked.id),
    'revoking is supposed to be final, including in bulk',
  );
  check(
    'extend --all: the row it reported moving really moved',
    getLink(EXTEND_SLUG, LINKS.extendAllRoom.id, LOCAL)?.exp === target,
    'the UPDATE reported a change the table does not show',
  );
  // Bulk scoping, asserted rather than argued. `--all` is the one statement here
  // that touches rows it was not handed the ids of, so the blast radius is the
  // property worth pinning: crossSlug sits on a DIFFERENT slug at a far-future
  // expiry, and the live matrix reads it long after this runs. While these
  // fixtures shared a slug with it this check could not have been written — the
  // --all above rewrote that very row, harmlessly but silently.
  check(
    'extend --all: leaves another post’s links alone',
    getLink(OTHER_SLUG, LINKS.crossSlug.id, LOCAL)?.exp === FAR_FUTURE_EXP,
    'a bulk extend reached across slugs — the cross-slug assertions below now ' +
      'depend on an expiry this statement moved',
  );
}

/**
 * The closeNotes / reopenNote round-trip, run before the worker is up.
 *
 * The only place notes-db's SQL executes under test. Not because the module is
 * unimportable — it loads fine under `node --test`, and its scan half is unit
 * tested in src/lib/galley-manifest.test.js — but because every function below
 * SHELLS OUT to `wrangler d1 execute` when called, so exercising the SQL needs a
 * migrated local database, which is exactly what smoke has and a unit test does
 * not. No HTTP request reaches these statements either: the worker writes notes
 * through its own binding and has no close.
 *
 * The property worth pinning is the SCOPING. `just galley-close` closes the ids
 * listed in the pulled file — a set chosen precisely so a second reviewer's
 * unread notes are out of reach — and that scoping lives in a WHERE clause,
 * where dropping a term is silent and reads as a successful close.
 *
 * Leaves the fixtures as it found them, because the live matrices read these
 * exact rows afterwards.
 */
export function checkCloseRoundTrip() {
  const target = NOTES.current.id;

  const wrongPost = closeNotes(OTHER_SLUG, [target], LOCAL);
  check(
    'close: an id belonging to another post closes nothing',
    wrongPost.length === 0,
    `got ${JSON.stringify(wrongPost)} — closing is not scoped to the named post`,
  );

  const closed = closeNotes(FIXTURE_SLUG, [target], LOCAL);
  check(
    'close: closes exactly the id it was handed',
    closed.length === 1 && closed[0] === target,
    `got ${JSON.stringify(closed)}`,
  );

  // The concurrent-reviewer guarantee, stated as an assertion rather than as a
  // comment: closing one reviewer's note must leave the other reviewer's alone.
  // A close that selected on revision drift instead of on the manifest would
  // take NOTES.stale with it, and nothing else in the suite would notice.
  const openAfter = listNotes(FIXTURE_SLUG, {}, LOCAL).map((note) => note.id);
  check(
    'close: leaves a second reviewer’s note open',
    openAfter.includes(NOTES.stale.id),
    'closing one reviewer’s round retired another reviewer’s unread note',
  );
  check(
    'close: the note it reported closing really closed',
    !openAfter.includes(target),
    'the UPDATE reported a change the table does not show',
  );

  const again = closeNotes(FIXTURE_SLUG, [target], LOCAL);
  check(
    'close: closing an already-closed note changes nothing',
    again.length === 0,
    `got ${JSON.stringify(again)} — re-running would rewrite the date a round closed`,
  );

  check(
    'reopen: puts a closed note back',
    reopenNote(FIXTURE_SLUG, target, LOCAL) === true,
    'a mis-close is only recoverable by hand-written SQL',
  );
  check(
    'reopen: an already-open note reports no change',
    reopenNote(FIXTURE_SLUG, target, LOCAL) === false,
    'reopen cannot distinguish "put back" from "was never closed"',
  );
  check(
    'reopen: restored the note to the open set',
    listNotes(FIXTURE_SLUG, {}, LOCAL).some((note) => note.id === target),
    'the live galley assertions below now run against a fixture that is not there',
  );

  // The closed fixture must survive all of the above untouched — the live
  // matrix reads it as the "addressed" case.
  check(
    'close: the closed fixture is still closed',
    !listNotes(FIXTURE_SLUG, {}, LOCAL).some((note) => note.id === NOTES.closed.id),
    'the closed-round fixture leaked back into the open set',
  );
}
