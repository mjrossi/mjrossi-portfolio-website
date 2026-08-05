import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isLinkActive } from './preview-links.js';

// These tests exist for the fail-closed branches specifically. The live matrix
// in scripts/smoke.mjs already covers "missing row" and "revoked row" over HTTP;
// what it cannot easily do is remove a binding or make D1 throw, which are the
// two paths CLAUDE.md promises fail closed and nothing was checking.

/**
 * A store whose single row is whatever you hand it. `null` means no such row.
 *
 * @param {{ revoked_at: number | null } | null} row
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
  const { DB } = storeReturning({ revoked_at: null });
  assert.equal(await isLinkActive(DB, 'a1b2c3d4e5f60718'), true);
});

test('a revoked row does not grant', async () => {
  const { DB } = storeReturning({ revoked_at: 1784634245000 });
  assert.equal(await isLinkActive(DB, 'a1b2c3d4e5f60718'), false);
});

test('a missing row does not grant', async () => {
  const { DB } = storeReturning(null);
  assert.equal(await isLinkActive(DB, 'a1b2c3d4e5f60718'), false);
});

// ── the branches smoke cannot reach ──────────────────

test('a missing DB binding does not grant', async () => {
  assert.equal(await isLinkActive(undefined, 'a1b2c3d4e5f60718'), false);
  assert.equal(await isLinkActive(null, 'a1b2c3d4e5f60718'), false);
});

test('a missing link id does not grant', async () => {
  const { DB } = storeReturning({ revoked_at: null });
  assert.equal(await isLinkActive(DB, undefined), false);
  assert.equal(await isLinkActive(DB, null), false);
  assert.equal(await isLinkActive(DB, ''), false);
});

test('a store that throws synchronously does not grant', async () => {
  const DB = {
    prepare() {
      throw new Error('D1_ERROR: no such table: preview_links');
    },
  };
  assert.equal(await isLinkActive(DB, 'a1b2c3d4e5f60718'), false);
});

test('a query that rejects does not grant', async () => {
  const DB = {
    prepare: () => ({
      bind: () => ({ first: async () => Promise.reject(new Error('D1_ERROR: network')) }),
    }),
  };
  assert.equal(await isLinkActive(DB, 'a1b2c3d4e5f60718'), false);
});

// An unrecognised row shape resolves in the same direction as every other
// failure here. `revoked_at: undefined` is the shape a renamed column would
// produce, and reading that as "not revoked" would hand out a withdrawn link.
test('a row without a revoked_at column does not grant', async () => {
  const { DB } = storeReturning({});
  assert.equal(await isLinkActive(DB, 'a1b2c3d4e5f60718'), false);
});

test('a non-null, non-number revoked_at does not grant', async () => {
  const { DB } = storeReturning({ revoked_at: 'yes' });
  assert.equal(await isLinkActive(DB, 'a1b2c3d4e5f60718'), false);
});

// ── the lookup itself ────────────────────────────────

test('looks up by primary key, with the id bound rather than interpolated', async () => {
  const { DB, seen } = storeReturning({ revoked_at: null });
  await isLinkActive(DB, 'a1b2c3d4e5f60718');
  assert.match(seen.sql, /WHERE id = \?/);
  assert.deepEqual(seen.bound, ['a1b2c3d4e5f60718']);
  // The slug is inside the signed payload, so the signature already binds
  // id↔slug. A slug predicate here would add nothing -- but if one is ever
  // added, it has to be bound too, and this assertion is where that shows up.
  assert.doesNotMatch(seen.sql, /a1b2c3d4e5f60718/);
});
