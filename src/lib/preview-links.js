// The allowlist half of a preview link: is the row still live?
//
// Separate from preview.js, which stays DB-free, and plain JS so `node --test`
// reaches the fail-closed branches smoke cannot. The store is duck-typed; a D1
// binding satisfies it.

/**
 * Is this link still live? Fails closed on every path: no store, no id, a store
 * that throws, a missing row, a revoked one, or an expired one. A row whose
 * `revoked_at` is anything but exactly null (missing, undefined) counts as revoked.
 *
 * The row's `exp` is the expiry actually enforced, and the one `just
 * preview-extend` moves. The token's signed `exp` is only the ceiling it can be
 * moved to. Dropping this check would quietly promote every link to its
 * ceiling, which is why smoke asserts a row-expired link 404s.
 *
 * Looked up by id only: the signature already binds id to slug.
 *
 * @param {{ prepare: (sql: string) => any } | null | undefined} DB
 * @param {string | null | undefined} id link id from the signed payload
 * @param {number} [now] epoch MS
 * @returns {Promise<boolean>}
 */
export async function isLinkActive(DB, id, now = Date.now()) {
  if (!DB || !id) return false;
  try {
    const row = await DB.prepare('SELECT revoked_at, exp FROM preview_links WHERE id = ?')
      .bind(id)
      .first();
    if (row == null || row.revoked_at !== null) return false;
    // Seconds, like the token's. Exclusive, as in verifyPreviewGrant. Anything
    // that is not a finite number counts as expired.
    return Number.isFinite(row.exp) && row.exp * 1000 > now;
  } catch {
    return false;
  }
}
