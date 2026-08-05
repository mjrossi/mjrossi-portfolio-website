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
 * throws, a query that rejects, a missing row, or a revoked one all return
 * false. There is deliberately no branch here where a failure widens access:
 * the worst outcome of a D1 problem is that preview links stop working, which
 * is recoverable and immediately visible, whereas the worst outcome of failing
 * open is an unpublished draft served to a link the operator believes they
 * revoked.
 *
 * A row is live only when `revoked_at` is exactly null. A column that came back
 * missing or undefined is treated as revoked -- unrecognised shapes resolve to
 * no grant, in the same direction as every other branch here.
 *
 * By primary key only. The slug is already inside the signed payload, so the
 * signature binds id↔slug and a second predicate here would add nothing.
 *
 * @param {{ prepare: (sql: string) => any } | null | undefined} DB
 * @param {string | null | undefined} id link id from the signed payload
 * @returns {Promise<boolean>}
 */
export async function isLinkActive(DB, id) {
  if (!DB || !id) return false;
  try {
    const row = await DB.prepare('SELECT revoked_at FROM preview_links WHERE id = ?')
      .bind(id)
      .first();
    return row != null && row.revoked_at === null;
  } catch {
    return false;
  }
}
