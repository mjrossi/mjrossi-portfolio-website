// The only file that knows the columns of preview_links.
//
// One copy for two runners: the worker through its D1 binding, and the CLI
// through scripts/d1-store.mjs. The table's invariants live INSIDE these
// statements (extendLink's ceiling, revokeLinks' slug scoping), so a second copy
// restated slightly wrong would fail silently. The store is duck-typed and
// passed in, so `node --test` can use a stub.
//
// The shape checks are domain validation, not escaping — parameters do that.
// They turn a mistyped id into a named error instead of an UPDATE that silently
// matches nothing.

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

/** Shaped like a slug: both are fields in the signed payload. */
function checkReviewer(reviewer) {
  if (reviewer === null || reviewer === undefined) return null;
  return checkSlug(reviewer, 'reviewer');
}

function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}

// ── writes ───────────────────────────────────────────

/**
 * Record minted links, in one round-trip.
 *
 * `maxExp` is the signed ceiling. It defaults to `exp` (no headroom), so a
 * caller that forgets it mints a link that can't be extended rather than one
 * that can be extended past its signature.
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
    // Not a hole (the token check refuses the difference) but an untrue row:
    // the roster would show a link live past its own signature.
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
 * Move a link's effective expiry; the URL is unchanged (migrations/0002).
 *
 * The ceiling is enforced in the statement, not the caller: a read-then-write
 * would leave a window and put the invariant in the wrong file.
 *
 * Returns the row it changed, or none. Every refusal (no such link, wrong post,
 * revoked, past the ceiling) otherwise looks like success; the caller says why.
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
 * Move the expiry of every LIVE link for one post: `preview-extend --all`, for
 * when the pubDate moved. Same ceiling as extendLink, so a partial result is
 * normal; returns the rows it moved so the caller can name the rest.
 *
 * An expired row is not matched. Letting a link lapse is a way to end it, so a
 * bulk re-clamp must not revive it; extendLink by id still can.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} slug
 * @param {number} exp new effective expiry, epoch SECONDS
 * @param {number} [now] epoch MS
 * @returns {Promise<{ id: string, exp: number, max_exp: number }[]>} the rows it moved
 */
export async function extendLinks(store, slug, exp, now = Date.now()) {
  checkSlug(slug);
  checkInteger(exp, 'exp');
  const { results } = await store
    .prepare(
      'UPDATE preview_links SET exp = ? ' +
        'WHERE slug = ? AND revoked_at IS NULL ' +
        'AND exp > ? ' +
        'AND ? <= max_exp ' +
        'RETURNING id, exp, max_exp',
    )
    .bind(exp, slug, Math.floor(now / 1000), exp)
    .all();
  return results;
}

/**
 * Revoke links for one post. Already-revoked rows keep their original date.
 *
 * The slug clause is the store's contract, but it is NOT what catches a
 * mistyped id at the CLI: there the slug is derived from the row, so the clause
 * can only match. scripts/resolve-id.mjs does that check. Keep the clause; don't
 * cite it as the safety property.
 *
 * Returns the ids it withdrew, via RETURNING (one round-trip, no race). An empty
 * result means nothing matched — the operator needs to hear that, since they run
 * this when a link has gone astray.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} slug
 * @param {{ id?: string | null }} [target] id omitted ⇒ every live link
 * @returns {Promise<string[]>} ids withdrawn, oldest first
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
 * Delete every link for the named posts. DESTRUCTIVE; smoke's fixture reset.
 * Real links are revoked, never deleted, so the roster stays a full inventory.
 *
 * The local-only guard is in scripts/links-db.mjs, so it protects only CLI
 * callers. scripts/smoke/static.mjs asserts no route imports this.
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

const COLUMNS = 'id, slug, reviewer, exp, max_exp, created_at, revoked_at';

/**
 * One link, by id, in ANY state — the lookup that lets the CLI take an id alone.
 *
 * Unfiltered on purpose: the useful refusals ("revoked on …", "past its
 * ceiling") need the row. It explains and resolves; it never gates.
 *
 * @param {{ prepare: (sql: string) => any }} store
 * @param {string} id
 * @returns {Promise<Record<string, unknown> | null>}
 */
export async function getLinkById(store, id) {
  checkLinkId(id);
  return store
    .prepare(`SELECT ${COLUMNS} FROM preview_links WHERE id = ?`)
    .bind(id)
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
 * Every link, across all posts, grouped by post. Per-post scoping matters in the
 * public worker, not in an authenticated CLI or the Access-gated Desk — and
 * without this, a link whose slug you forgot could never be revoked.
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
