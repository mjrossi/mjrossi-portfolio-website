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
 * @param {string} slug
 * @param {{ id?: string | null }} [target] id omitted ⇒ every live link
 * @param {{ local?: boolean }} [opts]
 */
export function revokeLinks(slug, { id = null } = {}, { local = false } = {}) {
  checkSlug(slug);
  const scope = id === null ? '' : ` AND id = '${checkLinkId(id)}'`;
  d1Exec(
    `UPDATE preview_links SET revoked_at = ${Date.now()} ` +
      `WHERE slug = '${slug}'${scope} AND revoked_at IS NULL`,
    { local },
  );
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
