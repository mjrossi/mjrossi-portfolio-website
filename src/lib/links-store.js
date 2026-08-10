// The only file that knows the columns of preview_links.
//
// Two runners, one copy. The operator CLI reaches D1 through wrangler
// (scripts/d1-store.mjs presents that as a D1-shaped store) and the deployed
// worker reaches it through its binding; both call the functions below. Before
// this module the CLI's statements lived in scripts/links-db.mjs and the
// worker had none, so building a read surface in the worker would have meant a
// second copy of a table whose invariants live INSIDE its statements —
// extendLink's ceiling and revokeLinks' slug scoping are enforced by the
// `WHERE` clause, not by the caller, and restating either slightly wrong is a
// silent failure.
//
// The store is duck-typed rather than typed as D1Database, and taken as an
// argument rather than imported, which is what lets one module serve the worker,
// the CLI and `node --test` alike. Same arrangement, and the same reasoning, as
// isLinkActive in src/lib/preview-links.js — which stays where it is because it
// is the worker's hot path on every preview request and has its own fail-closed
// contract to state.
//
// Plain JS, like schedule.js and preview-links.js: vanilla Node imports it from
// scripts/ without TypeScript tooling on that side.
//
// THE SHAPE CHECKS BELOW ARE DOMAIN VALIDATION, NOT ESCAPING. They used to be
// the thing that made string interpolation safe, back when each caller built its
// own SQL; parameters do that job now, and scripts/d1-store.mjs is where the
// argument for the CLI half is made. What they buy today is a named error at the
// call site instead of a silent no-op — a mistyped link id otherwise matches
// nothing, and an UPDATE that changed no rows looks identical to one that was
// never valid.

import { LINK_ID_RE, SLUG_RE } from './preview.js';

// ── input validation ─────────────────────────────────

function checkSlug(slug, label = 'slug') {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(`links-store: invalid ${label} ${JSON.stringify(slug)}`);
  }
  return slug;
}

function checkLinkId(id) {
  if (typeof id !== 'string' || !LINK_ID_RE.test(id)) {
    throw new Error(`links-store: invalid link id ${JSON.stringify(id)}`);
  }
  return id;
}

function checkInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`links-store: ${label} must be an integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** A reviewer label is shaped like a slug — both are fields in the signed payload. */
function checkReviewer(reviewer) {
  if (reviewer === null || reviewer === undefined) return null;
  return checkSlug(reviewer, 'reviewer');
}

/** `?, ?, ?` for a list of n values. */
function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}

// ── writes ───────────────────────────────────────────

/**
 * Record minted links.
 *
 * Plural so a caller needing several rows pays one round-trip rather than N --
 * which is what keeps smoke's fixture seeding cheap.
 *
 * `maxExp` is the ceiling: the token's own exp, which is signed and therefore
 * immutable, and the furthest extendLink can ever move `exp`. It DEFAULTS TO
 * `exp`, i.e. no headroom -- a caller that forgets it mints a link that cannot
 * be extended rather than one that can be extended past its signature, which is
 * the fail-closed direction.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {{ id: string, slug: string, reviewer?: string | null, exp: number,
 *           maxExp?: number, createdAt?: number, revokedAt?: number | null }[]} rows
 */
export async function recordLinks(store, rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('links-store: recordLinks needs at least one row');
  }
  const now = Date.now();
  const params = [];
  for (const row of rows) {
    const exp = checkInteger(row.exp, 'exp');
    const maxExp = checkInteger(row.maxExp ?? exp, 'maxExp');
    // A ceiling below the effective expiry is not a security hole -- the token
    // check would refuse the difference anyway -- but it is a row that says
    // something untrue, and the roster would report a link as live past the
    // point its own signature stops verifying.
    if (maxExp < exp) {
      throw new Error(
        `links-store: maxExp ${maxExp} is earlier than exp ${exp} for link ${row.id}`,
      );
    }
    params.push(
      checkLinkId(row.id),
      checkSlug(row.slug),
      checkReviewer(row.reviewer ?? null),
      exp,
      maxExp,
      checkInteger(row.createdAt ?? now, 'createdAt'),
      row.revokedAt == null ? null : checkInteger(row.revokedAt, 'revokedAt'),
    );
  }
  const tuples = rows.map(() => `(${placeholders(7)})`).join(', ');
  await store
    .prepare(
      'INSERT INTO preview_links (id, slug, reviewer, exp, max_exp, created_at, revoked_at) ' +
        `VALUES ${tuples}`,
    )
    .bind(...params)
    .run();
}

/**
 * Move a link's effective expiry, without touching the link itself.
 *
 * This is the whole of `just preview-extend`. The URL in the reviewer's hands
 * is unchanged, because `exp` here is not the one inside the signature -- see
 * migrations/0002 for the clock and the cap above it.
 *
 * THE CEILING IS ENFORCED IN THE STATEMENT, not by the caller. A read-then-write
 * would be two round-trips with a window between them, and would put the one
 * invariant that keeps an extendable link from becoming a permanent one in the
 * script rather than in the module that owns the table. Same argument as the
 * galley write quota being a single INSERT ... SELECT.
 *
 * RETURNS THE ROW IT ACTUALLY CHANGED, empty when it changed nothing, for the
 * same reason revokeLinks does: every refusal here (no such link, wrong post,
 * revoked, past the ceiling) is otherwise indistinguishable from success. The
 * caller is expected to look up why and say so.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} slug
 * @param {string} id
 * @param {number} exp new effective expiry, epoch SECONDS
 * @returns {Promise<{ id: string, exp: number, max_exp: number }[]>} one row, or none
 */
export async function extendLink(store, slug, id, exp) {
  checkSlug(slug);
  checkLinkId(id);
  checkInteger(exp, 'exp');
  const { results } = await store
    .prepare(
      'UPDATE preview_links SET exp = ? ' +
        'WHERE slug = ? AND id = ? AND revoked_at IS NULL ' +
        'AND ? <= max_exp ' +
        'RETURNING id, exp, max_exp',
    )
    .bind(exp, slug, id, exp)
    .all();
  return results;
}

/**
 * Move the effective expiry of EVERY live link for one post.
 *
 * This is `just preview-extend <slug> --all`, and it exists for one situation:
 * the pubDate moved. A link's expiry is clamped to publication when it is minted,
 * so pushing a draft back leaves every outstanding link expiring on the old date
 * — and reminting them would defeat the point of extending at all. One statement
 * re-clamps the lot, and not one reviewer's URL changes.
 *
 * Same ceiling, enforced the same way and in the same place: rows whose signature
 * will not reach the new expiry are simply not matched, so an --all that moves
 * four links out of five reports four. That is why this RETURNS THE ROWS IT
 * CHANGED rather than a count — the caller names the ones it could not move.
 *
 * Scoped to the slug, like every other write here.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} slug
 * @param {number} exp new effective expiry, epoch SECONDS
 * @returns {Promise<{ id: string, exp: number, max_exp: number }[]>} the rows it moved
 */
export async function extendLinks(store, slug, exp) {
  checkSlug(slug);
  checkInteger(exp, 'exp');
  const { results } = await store
    .prepare(
      'UPDATE preview_links SET exp = ? ' +
        'WHERE slug = ? AND revoked_at IS NULL ' +
        'AND ? <= max_exp ' +
        'RETURNING id, exp, max_exp',
    )
    .bind(exp, slug, exp)
    .all();
  return results;
}

/**
 * Revoke links for one post.
 *
 * ALWAYS scoped to the slug, even when an id is given. A mistyped id belonging
 * to another post therefore does nothing, rather than quietly withdrawing
 * someone else's link -- the failure mode that would be hardest to notice,
 * since the operator sees a successful command either way.
 *
 * Already-revoked rows are left alone (`revoked_at IS NULL`), so re-running
 * does not rewrite the date a link was actually withdrawn.
 *
 * RETURNS THE IDS IT ACTUALLY WITHDREW, and the caller is expected to say so.
 * Both no-op cases here are silent by construction -- an id belonging to another
 * post is scoped away, and a slug whose links are all revoked already matches
 * nothing -- so without this the command that takes a link back reports success
 * either way. That is the wrong default for a withdrawal: the operator runs it
 * precisely when a link has gone astray and they need to know it is dead.
 *
 * `RETURNING` rather than a second SELECT so this stays one round-trip and
 * cannot race a concurrent revoke between the write and the read-back.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} slug
 * @param {{ id?: string | null }} [target] id omitted ⇒ every live link
 * @returns {Promise<string[]>} ids of the rows this call withdrew, oldest first
 */
export async function revokeLinks(store, slug, { id = null } = {}) {
  checkSlug(slug);
  const params = [Date.now(), slug];
  let scope = '';
  if (id !== null) {
    scope = ' AND id = ?';
    params.push(checkLinkId(id));
  }
  const { results } = await store
    .prepare(
      'UPDATE preview_links SET revoked_at = ? ' +
        `WHERE slug = ?${scope} AND revoked_at IS NULL ` +
        'RETURNING id',
    )
    .bind(...params)
    .all();
  return results.map((row) => row.id);
}

/**
 * Delete every link for the named posts. DESTRUCTIVE.
 *
 * A test-fixture helper: scripts/smoke.mjs resets its rows before each run.
 * Nothing else in this feature deletes a row -- revoking is how a real link is
 * withdrawn, and it keeps the row so the roster stays a complete inventory.
 *
 * The "local database only" guard lives in scripts/links-db.mjs rather than
 * here, because `--local` is a fact about which database a CLI was pointed at
 * and this module deliberately does not know what a database is.
 *
 * That guard is CLI-side, so it protects only callers that go through the CLI.
 * While this statement lived in scripts/ that was every caller by construction —
 * the worker's module graph did not reach it. It does now, so the claim is only
 * as good as the fact that no route imports this: scripts/smoke/static.mjs
 * asserts exactly that, over src/pages/** and src/middleware.ts, in the same
 * shape as the previewSlug-must-not-reach-blog.ts grep. Don't restore the old
 * "the worker has no path to this function at all" wording — it stopped being
 * structural the moment the SQL moved here.
 *
 * Scoped by slug rather than by reviewer, because view-only rows have no
 * reviewer to scope by.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string[]} slugs
 */
export async function clearLinks(store, slugs) {
  if (!Array.isArray(slugs) || slugs.length === 0) return;
  const params = slugs.map((slug) => checkSlug(slug));
  await store
    .prepare(`DELETE FROM preview_links WHERE slug IN (${placeholders(params.length)})`)
    .bind(...params)
    .run();
}

// ── reads ────────────────────────────────────────────

/** The column list every read below shares. */
const COLUMNS = 'id, slug, reviewer, exp, max_exp, created_at, revoked_at';

/**
 * One link, by post and id.
 *
 * Exists to EXPLAIN A REFUSAL, never to gate one -- extendLink and revokeLinks
 * both decide in their own statement, so nothing here is load-bearing and a
 * stale read cannot widen anything. `just preview-extend` calls it only after
 * an UPDATE has already changed nothing, to say which of the several silent
 * reasons applied.
 *
 * Scoped by slug as well as id, like every other write in this file: an id
 * belonging to another post reads as "no such link" rather than answering about
 * a draft the operator did not name.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} slug
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getLink(store, slug, id) {
  checkSlug(slug);
  checkLinkId(id);
  return store
    .prepare(`SELECT ${COLUMNS} FROM preview_links WHERE slug = ? AND id = ?`)
    .bind(slug, id)
    .first();
}

/**
 * Every link minted for one post, oldest first.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} slug
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listLinks(store, slug) {
  checkSlug(slug);
  const { results } = await store
    .prepare(`SELECT ${COLUMNS} FROM preview_links WHERE slug = ? ORDER BY created_at ASC`)
    .bind(slug)
    .all();
  return results;
}

/**
 * Every link in the table, across all posts. Grouped by post, oldest first.
 *
 * The per-post scoping everywhere else in this feature is load-bearing in the
 * PUBLIC worker -- handing someone one draft must not hand them the rest. That
 * reasoning does not reach a CLI already authenticated as the operator, nor the
 * Access-gated Desk at /admin, which exists precisely to answer "what is
 * outstanding?" across every draft at once. Without a list like this, forgetting
 * which slug a link was minted for makes it unrevocable: listLinks needs a slug
 * to answer, and a token is recorded nowhere else. An inventory you can only
 * query by knowing the answer is not much of an inventory.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @returns {Promise<Record<string, unknown>[]>}
 */
export async function listAllLinks(store) {
  const { results } = await store
    .prepare(`SELECT ${COLUMNS} FROM preview_links ORDER BY slug ASC, created_at ASC`)
    .all();
  return results;
}
