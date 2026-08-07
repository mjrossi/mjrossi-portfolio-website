// The allowlist half of a preview link: is the row still live?
//
// Split out of src/middleware.ts for one reason -- middleware is TypeScript and
// imports `astro:middleware`, so `node --test` cannot load it, and this function
// was therefore the only fail-closed branch in the feature with no persistent
// test. `return false` inside a bare catch is one character away from
// `return true`, and nothing in the suite would have gone red. Plain JS for the
// same reason as schedule.js and galley-relocate.js: vanilla Node imports it
// directly, no TypeScript tooling on the test side.
//
// NOT merged into src/lib/preview.js, which is deliberately DB-free so that one
// module runs unchanged in the worker, under node --test, and in
// scripts/preview-link.mjs. This one takes the store as an argument rather than
// importing a binding, which is what keeps that property true of both files.
//
// The store is duck-typed rather than typed as D1Database so a test can pass a
// three-line stub. A real D1 binding satisfies it structurally.

/**
 * Is this link still live?
 *
 * Every preview token names a row in preview_links, and a link is only as good
 * as that row. Fails closed on every path -- no store, no id, a store that
 * throws, a query that rejects, a missing row, a revoked one, or one whose
 * expiry has passed all return false. There is deliberately no branch here
 * where a failure widens access: the worst outcome of a D1 problem is that
 * preview links stop working, which is recoverable and immediately visible,
 * whereas the worst outcome of failing open is an unpublished draft served to a
 * link the operator believes they revoked.
 *
 * TWO conditions (see migrations/0002):
 *
 *   revoked_at IS NULL -- nobody has withdrawn it.
 *   exp is in the future -- THE CLOCK. The expiry a request is actually judged
 *                           against, which `just preview-extend` moves in place
 *                           so a reviewer needing more time keeps the URL they
 *                           already have.
 *
 * The token carries its own exp, checked by verifyPreviewGrant before this
 * function is ever reached. That one is signed and therefore immutable, which
 * is exactly why it cannot be the working expiry: it is the CAP on how far the
 * clock above can be wound, not the clock. Both are enforced, so dropping
 * either still leaves a link that expires -- but dropping this one silently
 * promotes every link to its full cap, which is why smoke asserts a row-expired
 * link 404s even with a perfectly valid token.
 *
 * A row is live only when `revoked_at` is exactly null. A column that came back
 * missing or undefined is treated as revoked -- unrecognised shapes resolve to
 * no grant, in the same direction as every other branch here. `exp` is read the
 * same way: anything that is not a finite number is treated as expired.
 *
 * By primary key only. The slug is already inside the signed payload, so the
 * signature binds id↔slug and a second predicate here would add nothing.
 *
 * @param {{ prepare: (sql: string) => any } | null | undefined} DB
 * @param {string | null | undefined} id link id from the signed payload
 * @param {number} [now] epoch MS; injectable so the boundary is testable
 * @returns {Promise<boolean>}
 */
export async function isLinkActive(DB, id, now = Date.now()) {
  if (!DB || !id) return false;
  try {
    const row = await DB.prepare('SELECT revoked_at, exp FROM preview_links WHERE id = ?')
      .bind(id)
      .first();
    if (row == null || row.revoked_at !== null) return false;
    // `exp` is epoch SECONDS (like the token's, and unlike created_at/revoked_at
    // in the same table -- each column matches the thing it mirrors). Number.isFinite
    // rather than the global isFinite, so a string or NaN is rejected instead of
    // coerced, and rather than a bare `> now` comparison, which would let
    // undefined through as NaN-false only by accident.
    //
    // Exclusive, exactly as verifyPreviewGrant treats the token's own exp: a row
    // whose exp is precisely now has expired. The two comparisons are written
    // the same way on purpose.
    return Number.isFinite(row.exp) && row.exp * 1000 > now;
  } catch {
    return false;
  }
}
