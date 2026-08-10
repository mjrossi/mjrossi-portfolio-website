import test from 'node:test';
import assert from 'node:assert/strict';
import { wranglerStore } from '../../scripts/d1-store.mjs';

// scripts/d1-store.mjs is a SHAPE CONTRACT with the D1 binding, and that is the
// only thing tested here. The store modules in src/lib/*-store.js are written
// once, in ordinary D1 idiom, and run on two implementations: the worker's
// binding and this façade. Anywhere the two return differently shaped results,
// one copy of the SQL silently means two things.
//
// This file lives under src/ rather than next to the module because `npm test`
// globs 'src/**/*.test.js' — the same reason src/lib/galley-quote.test.js sits
// here for code served out of public/scripts/.
//
// `exec` is the seam. The real one shells out to wrangler via execFileSync, so
// without it none of this is reachable without an experimental module-mocking
// flag on the whole test run.

/** A store whose statements return `rows`, recording what SQL it was handed. */
function storeOf(rows, meta = { changes: rows.length }, success) {
  const seen = [];
  const store = wranglerStore({
    local: true,
    exec: (sql) => {
      seen.push(sql);
      return { results: rows, meta, ...(success === undefined ? {} : { success }) };
    },
  });
  return { store, seen };
}

test('first() returns the whole row and first(column) returns that column', async () => {
  // The divergence this exists to prevent is silent AND truthy: a façade whose
  // first() ignores its argument hands back the row where the binding hands
  // back a scalar, and `Number(row)` is NaN rather than a throw.
  const { store } = storeOf([{ id: 'a1b2c3d4e5f60718', exp: 1234 }]);
  assert.deepEqual(await store.prepare('SELECT *').bind().first(), {
    id: 'a1b2c3d4e5f60718',
    exp: 1234,
  });
  assert.equal(await store.prepare('SELECT *').bind().first('exp'), 1234);
});

test('a query that matched nothing is null on both shapes, never undefined', async () => {
  // D1 answers null. `undefined` would pass a `== null` test and fail a
  // `=== null` one, which is exactly the kind of difference that survives review.
  const { store } = storeOf([]);
  assert.equal(await store.prepare('SELECT *').bind().first(), null);
  assert.equal(await store.prepare('SELECT *').bind().first('exp'), null);
});

test('a column the row does not carry is null, not undefined', async () => {
  const { store } = storeOf([{ id: 'a1b2c3d4e5f60718' }]);
  assert.equal(await store.prepare('SELECT *').bind().first('nope'), null);
});

test('all() reports wrangler’s own success rather than a hardcoded true', async () => {
  // A future wrangler that reports a failed statement with exit code 0 must not
  // be read as a success — the same class of silent failure d1Execute's shape
  // check refuses.
  const { store } = storeOf([], { changes: 0 }, false);
  const res = await store.prepare('DELETE FROM preview_links').bind().all();
  assert.equal(res.success, false);
});

test('meta rides through all() and run() untouched', async () => {
  // `meta.changes === 0` is how a refusal arrives from a conditional UPDATE —
  // extendLink's ceiling and /api/galley's write quota both read it. A façade
  // that dropped meta would turn every refusal into `undefined === 0`, i.e.
  // false, i.e. a refused write reported as accepted.
  const { store } = storeOf([], { changes: 0, last_row_id: 7 });
  assert.deepEqual((await store.prepare('UPDATE preview_links SET exp = ?').bind(1).all()).meta, {
    changes: 0,
    last_row_id: 7,
  });
  assert.deepEqual((await store.prepare('UPDATE preview_links SET exp = ?').bind(1).run()).meta, {
    changes: 0,
    last_row_id: 7,
  });
});

test('bind() returns a new statement rather than mutating the prepared one', async () => {
  // Matches D1, where re-binding one prepared statement is how a single query
  // shape serves several rows.
  //
  // The two bound statements are held BEFORE either runs, which is the only
  // arrangement that can tell the two implementations apart. Binding and
  // running each in turn passes just as happily against a mutating
  // `this.params = params; return this` — verified by fault injection — so a
  // sequential version of this test would be green through the bug.
  const { store, seen } = storeOf([]);
  const stmt = store.prepare('SELECT * FROM preview_links WHERE id = ?');
  const first = stmt.bind('a1b2c3d4e5f60718');
  const second = stmt.bind('0f1e2d3c4b5a6978');
  await first.all();
  await second.all();
  assert.deepEqual(seen, [
    "SELECT * FROM preview_links WHERE id = 'a1b2c3d4e5f60718'",
    "SELECT * FROM preview_links WHERE id = '0f1e2d3c4b5a6978'",
  ]);
});

test('the façade is partial on purpose — absent D1 methods throw', async () => {
  // The header's rule, pinned. It licenses omitting methods D1 has that this
  // repo does not use; it does NOT license implementing one with a signature
  // D1 does not have, which is why first(column) is real above.
  const { store } = storeOf([]);
  const stmt = store.prepare('SELECT 1').bind();
  assert.equal(typeof stmt.raw, 'undefined');
  assert.equal(typeof stmt.batch, 'undefined');
});
