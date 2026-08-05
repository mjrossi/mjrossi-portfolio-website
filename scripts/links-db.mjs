// The only file that knows the columns of preview_links.
//
// Four callers touch the allowlist -- preview-link.mjs records,
// preview-roster.mjs lists and revokes, smoke.mjs seeds fixtures -- and
// spreading one table's SQL across them would mean restating the column list
// and the "this interpolation is safe" argument once per script. Here that
// argument is made once and ENFORCED: every value reaching a statement below
// has been shape-checked in this file, so no caller can weaken it by forgetting.
//
// Same rationale as scripts/dev-vars.mjs, one layer up: smoke seeds its fixture
// rows through the same function production mints through, so a schema change
// that breaks minting breaks the fixture in the same commit rather than leaving
// a suite that passes against a table nothing writes any more.

import { LINK_ID_RE, SLUG_RE } from '../src/lib/preview.js';
import { d1Exec, d1Query } from './d1.mjs';

// ── input validation ─────────────────────────────────
//
// SLUG_RE and LINK_ID_RE admit no quotes, spaces, or backslashes, which is what
// makes interpolating these values into SQL safe. wrangler's `--command` takes
// a string rather than bound parameters, so this is the boundary that has to
// hold; it is checked here rather than trusted from the caller.

function checkSlug(slug, label = 'slug') {
  if (typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    throw new Error(`links-db: invalid ${label} ${JSON.stringify(slug)}`);
  }
  return slug;
}

function checkLinkId(id) {
  if (typeof id !== 'string' || !LINK_ID_RE.test(id)) {
    throw new Error(`links-db: invalid link id ${JSON.stringify(id)}`);
  }
  return id;
}

function checkInteger(value, label) {
  if (!Number.isInteger(value)) {
    throw new Error(`links-db: ${label} must be an integer, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** SQL literal for a reviewer: a quoted label, or NULL for a view-only link. */
function reviewerLiteral(reviewer) {
  if (reviewer === null || reviewer === undefined) return 'NULL';
  return `'${checkSlug(reviewer, 'reviewer')}'`;
}

// ── writes ───────────────────────────────────────────

/**
 * Record minted links.
 *
 * Plural so a caller needing several rows pays one wrangler round-trip rather
 * than N -- which is what keeps smoke's fixture seeding cheap.
 *
 * @param {{ id: string, slug: string, reviewer?: string | null, exp: number,
 *           revokedAt?: number | null }[]} rows
 * @param {{ local?: boolean }} [opts]
 */
export function recordLinks(rows, { local = false } = {}) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('links-db: recordLinks needs at least one row');
  }
  const now = Date.now();
  const values = rows.map((row) => {
    const id = checkLinkId(row.id);
    const slug = checkSlug(row.slug);
    const exp = checkInteger(row.exp, 'exp');
    const createdAt = checkInteger(row.createdAt ?? now, 'createdAt');
    const revokedAt = row.revokedAt == null ? 'NULL' : checkInteger(row.revokedAt, 'revokedAt');
    return `('${id}', '${slug}', ${reviewerLiteral(row.reviewer ?? null)}, ${exp}, ${createdAt}, ${revokedAt})`;
  });
  d1Exec(
    'INSERT INTO preview_links (id, slug, reviewer, exp, created_at, revoked_at) VALUES ' +
      `${values.join(', ')}`,
    { local },
  );
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
 * @param {string} slug
 * @param {{ id?: string | null }} [target] id omitted ⇒ every live link
 * @param {{ local?: boolean }} [opts]
 * @returns {string[]} ids of the rows this call withdrew, oldest first
 */
export function revokeLinks(slug, { id = null } = {}, { local = false } = {}) {
  checkSlug(slug);
  const scope = id === null ? '' : ` AND id = '${checkLinkId(id)}'`;
  const rows = d1Query(
    `UPDATE preview_links SET revoked_at = ${Date.now()} ` +
      `WHERE slug = '${slug}'${scope} AND revoked_at IS NULL ` +
      'RETURNING id',
    { local },
  );
  return rows.map((row) => row.id);
}

/**
 * Delete every link for the named posts. LOCAL ONLY.
 *
 * A test-fixture helper: scripts/smoke.mjs resets its rows before each run.
 * Refuses to run against production, because nothing else in this feature
 * deletes a row and an operator reaching for a delete is almost certainly
 * looking for revokeLinks instead.
 *
 * Scoped by slug rather than by reviewer, because view-only rows have no
 * reviewer to scope by.
 *
 * @param {string[]} slugs
 * @param {{ local?: boolean }} [opts]
 */
export function clearLinks(slugs, { local = false } = {}) {
  if (!local) {
    throw new Error('links-db: clearLinks is local-only — use revokeLinks to withdraw a real link');
  }
  const list = slugs.map((slug) => `'${checkSlug(slug)}'`).join(', ');
  d1Exec(`DELETE FROM preview_links WHERE slug IN (${list})`, { local: true });
}

// ── reads ────────────────────────────────────────────

/**
 * Every link minted for one post, oldest first.
 *
 * @param {string} slug
 * @param {{ local?: boolean }} [opts]
 * @returns {{ id: string, slug: string, reviewer: string | null, exp: number,
 *             created_at: number, revoked_at: number | null }[]}
 */
export function listLinks(slug, { local = false } = {}) {
  checkSlug(slug);
  return d1Query(
    'SELECT id, slug, reviewer, exp, created_at, revoked_at FROM preview_links ' +
      `WHERE slug = '${slug}' ORDER BY created_at ASC`,
    { local },
  );
}

/**
 * Every link in the table, across all posts. Grouped by post, oldest first.
 *
 * The per-post scoping everywhere else in this feature is load-bearing in the
 * WORKER -- handing someone one draft must not hand them the rest. That
 * reasoning does not reach a local CLI already authenticated as the operator,
 * and without a list like this, forgetting which slug a link was minted for
 * makes it unrevocable: `just preview-roster` needs a slug to answer, and a
 * token is recorded nowhere else. An inventory you can only query by knowing
 * the answer is not much of an inventory.
 *
 * @param {{ local?: boolean }} [opts]
 * @returns {{ id: string, slug: string, reviewer: string | null, exp: number,
 *             created_at: number, revoked_at: number | null }[]}
 */
export function listAllLinks({ local = false } = {}) {
  return d1Query(
    'SELECT id, slug, reviewer, exp, created_at, revoked_at FROM preview_links ' +
      'ORDER BY slug ASC, created_at ASC',
    { local },
  );
}
