import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLinkActive } from './preview-links.js';

// These tests exist for the fail-closed branches specifically. The live matrix
// in scripts/smoke.mjs already covers "missing row" and "revoked row" over HTTP;
// what it cannot easily do is remove a binding or make D1 throw, which are the
// two paths CLAUDE.md promises fail closed and nothing was checking.
//
// The expiry cases below are the second half of that. `exp` on the row is the
// EFFECTIVE expiry (the token's own exp is the immutable ceiling above it, and
// belongs to preview.test.js) -- it is what `just preview-extend` moves, so it
// is the clock that actually decides whether a link is live.

const ID = 'a1b2c3d4e5f60718';
const NOW = Date.parse('2026-07-20T12:00:00Z');
const FUTURE = Math.floor(NOW / 1000) + 3600; // an hour of life left

/**
 * A store whose single row is whatever you hand it. `null` means no such row.
 *
 * @param {{ revoked_at?: number | null, exp?: unknown } | null} row
 */
function storeReturning(row) {
  const seen = { sql: /** @type {string | null} */ (null), bound: /** @type {unknown[]} */ ([]) };
  const DB = {
    prepare(sql) {
      seen.sql = sql;
      return {
        bind(...values) {
          seen.bound = values;
          return { first: async () => row };
        },
      };
    },
  };
  return { DB, seen };
}

test('a live row grants', async () => {
  const { DB } = storeReturning({ revoked_at: null, exp: FUTURE });
  assert.equal(await isLinkActive(DB, ID, NOW), true);
});

test('a revoked row does not grant', async () => {
  const { DB } = storeReturning({ revoked_at: 1784634245000, exp: FUTURE });
  assert.equal(await isLinkActive(DB, ID, NOW), false);
});

test('a missing row does not grant', async () => {
  const { DB } = storeReturning(null);
  assert.equal(await isLinkActive(DB, ID, NOW), false);
});

// ── expiry ───────────────────────────────────────────
//
// The row's exp is what `just preview-extend` rewrites. Nothing else enforces
// it: the token's ceiling is checked in verifyPreviewGrant, and it is deliberately
// much further out, so a bug here does not fail closed -- it silently promotes
// every link to its full 30-day ceiling. scripts/smoke.mjs proves the same thing
// over HTTP for exactly that reason.

test('an expired row does not grant, however live the token still is', async () => {
  const { DB } = storeReturning({ revoked_at: null, exp: Math.floor(NOW / 1000) - 60 });
  assert.equal(await isLinkActive(DB, ID, NOW), false);
});

// Exclusive, matching verifyPreviewGrant's `exp * 1000 <= now`. Written as a
// pair so a change to one side of the boundary cannot pass by moving the other.
test('the expiry boundary is exclusive — exp exactly now has expired', async () => {
  const exact = Math.floor(NOW / 1000);
  const { DB } = storeReturning({ revoked_at: null, exp: exact });
  assert.equal(await isLinkActive(DB, ID, exact * 1000), false);
  assert.equal(await isLinkActive(DB, ID, exact * 1000 - 1), true);
});

test('a revoked row does not grant even while unexpired', async () => {
  const { DB } = storeReturning({ revoked_at: 1784634245000, exp: FUTURE });
  assert.equal(await isLinkActive(DB, ID, NOW), false);
});

// Every unrecognised exp resolves in the same direction as every other failure
// here. `undefined` is the shape a renamed or dropped column produces, and a
// bare `row.exp * 1000 > now` would read a string exp as valid by coercion.
test('an unusable exp does not grant', async () => {
  for (const exp of [undefined, null, 'soon', NaN, Infinity, {}]) {
    const { DB } = storeReturning({ revoked_at: null, exp });
    assert.equal(await isLinkActive(DB, ID, NOW), false, `exp: ${String(exp)}`);
  }
});

// ── the branches smoke cannot reach ──────────────────

test('a missing DB binding does not grant', async () => {
  assert.equal(await isLinkActive(undefined, ID, NOW), false);
  assert.equal(await isLinkActive(null, ID, NOW), false);
});

test('a missing link id does not grant', async () => {
  const { DB } = storeReturning({ revoked_at: null, exp: FUTURE });
  assert.equal(await isLinkActive(DB, undefined, NOW), false);
  assert.equal(await isLinkActive(DB, null, NOW), false);
  assert.equal(await isLinkActive(DB, '', NOW), false);
});

test('a store that throws synchronously does not grant', async () => {
  const DB = {
    prepare() {
      throw new Error('D1_ERROR: no such table: preview_links');
    },
  };
  assert.equal(await isLinkActive(DB, ID, NOW), false);
});

test('a query that rejects does not grant', async () => {
  const DB = {
    prepare: () => ({
      bind: () => ({ first: async () => Promise.reject(new Error('D1_ERROR: network')) }),
    }),
  };
  assert.equal(await isLinkActive(DB, ID, NOW), false);
});

// An unrecognised row shape resolves in the same direction as every other
// failure here. `revoked_at: undefined` is the shape a renamed column would
// produce, and reading that as "not revoked" would hand out a withdrawn link.
test('a row without a revoked_at column does not grant', async () => {
  const { DB } = storeReturning({ exp: FUTURE });
  assert.equal(await isLinkActive(DB, ID, NOW), false);
});

test('a non-null, non-number revoked_at does not grant', async () => {
  const { DB } = storeReturning({ revoked_at: 'yes', exp: FUTURE });
  assert.equal(await isLinkActive(DB, ID, NOW), false);
});

// ── the lookup itself ────────────────────────────────

test('looks up by primary key, with the id bound rather than interpolated', async () => {
  const { DB, seen } = storeReturning({ revoked_at: null, exp: FUTURE });
  await isLinkActive(DB, ID, NOW);
  assert.match(seen.sql, /WHERE id = \?/);
  assert.deepEqual(seen.bound, [ID]);
  // Both columns the decision rests on have to actually be selected. A SELECT
  // narrowed back to revoked_at would make every exp read undefined, which the
  // expiry tests above would catch as "nothing grants" -- but this says why.
  assert.match(seen.sql, /revoked_at/);
  assert.match(seen.sql, /exp/);
  // The slug is inside the signed payload, so the signature already binds
  // id↔slug. A slug predicate here would add nothing -- but if one is ever
  // added, it has to be bound too, and this assertion is where that shows up.
  assert.doesNotMatch(seen.sql, new RegExp(ID));
});

test('defaults its clock to now, so a caller that omits it still expires links', async () => {
  const past = storeReturning({ revoked_at: null, exp: Math.floor(Date.now() / 1000) - 60 });
  const soon = storeReturning({ revoked_at: null, exp: Math.floor(Date.now() / 1000) + 60 });
  assert.equal(await isLinkActive(past.DB, ID), false);
  assert.equal(await isLinkActive(soon.DB, ID), true);
});
