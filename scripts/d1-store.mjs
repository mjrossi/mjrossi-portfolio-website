// A D1-compatible façade over `wrangler d1 execute`.
//
// WHY THIS EXISTS. The statements against preview_links and galley_notes have
// two runners: the deployed worker, which reaches D1 through its binding with
// bound parameters, and the operator CLI, which reaches it through wrangler —
// whose `--command` takes a string and has no parameters at all. Those two
// mechanisms used to mean two copies of every statement, in scripts/links-db.mjs
// and scripts/notes-db.mjs, with the invariants that live INSIDE a statement
// (extendLink's `exp <= max_exp` ceiling, revokeLinks' slug scoping) written out
// twice and free to drift apart.
//
// So the SQL moved to src/lib/links-store.js and src/lib/notes-store.js, written
// once in ordinary D1 idiom, and this file makes the CLI look like a D1 binding
// so that one copy runs on both. `prepare(sql).bind(...params).all()` here does
// what it does in the worker; the only difference is that the parameters are
// rendered into the command string on the way out, by renderSql below.
//
// THE ESCAPING BOUNDARY IS src/lib/sql-literal.js, which this file delegates to.
// The old arrangement made the "this interpolation is safe" argument twice, once
// per table module, and rested it on the SLUG_RE / NOTE_ID_RE shape checks —
// which worked only because every value reaching a statement happened to be an
// identifier. It was already not quite true for reviewer prose, which
// notes-db.mjs escaped separately with its own quote-doubling helper. Now the
// argument is made once, for values of any shape, in a module `node --test` can
// reach — and the shape checks in the store modules go back to being what they
// read like: domain validation with a good error message, not a safety
// mechanism.
//
// The façade is deliberately partial. It implements the four methods this
// repo's statements actually use — bind, all, first, run — and nothing else. A
// caller reaching for D1 API this does not have should get a TypeError here
// rather than a subtly different behaviour. Note the direction of that rule:
// it licenses omitting `raw()` and `batch()`, which are absent and therefore
// throw. It does NOT license implementing a method D1 has with a signature D1
// does not — hence `first(column)` below.
//
// The one place the two paths genuinely cannot match: D1 caps a statement at
// 100 bound parameters, and rendered text has no such limit. recordLinks binds
// 7 per row and seedNotes 14, so a multi-row insert crosses that ceiling on the
// binding long before it troubles this file. Nothing reaches it today (smoke's
// largest fixture set is 12 links, 84 parameters) and the worker never writes,
// but a future batch write belongs chunked rather than assumed portable.

import { renderSql } from '../src/lib/sql-literal.js';
import { d1Execute } from './d1.mjs';

/**
 * A prepared statement, in the shape the D1 binding hands back.
 *
 * `bind` returns a NEW statement rather than mutating this one, matching D1,
 * where re-binding a prepared statement is how one query shape serves several
 * rows.
 *
 * Every method is async so the store modules can be written once and awaited on
 * both paths. The work underneath is `execFileSync` and therefore blocking —
 * this is a CLI, and pretending otherwise would only add a thread of concurrency
 * nothing here wants.
 */
class WranglerStatement {
  constructor(sql, params, local, exec) {
    this.sql = sql;
    this.params = params;
    this.local = local;
    this.exec = exec;
  }

  bind(...params) {
    return new WranglerStatement(this.sql, params, this.local, this.exec);
  }

  async all() {
    // `success` is wrangler's own, not a constant. Hardcoding `true` here would
    // mean a future wrangler that reports a failed statement with exit code 0
    // gets read as a success by every caller — the same class of silent-empty
    // failure d1Execute's shape check exists to refuse.
    const { results, meta, success } = this.exec(renderSql(this.sql, this.params), {
      local: this.local,
    });
    return { results, meta, success: success ?? true };
  }

  /**
   * @param {string} [column] D1's own overload: name a column and get that
   *   value rather than the whole row. Implemented rather than refused, because
   *   this is API D1 HAS — the "partial façade" argument in the header is about
   *   methods it does not. A no-arg `first()` returning the row where the worker
   *   returns a scalar is a divergence that is silent AND truthy: `Number(row)`
   *   is NaN, a comparison is false, and neither throws.
   */
  async first(column) {
    const { results } = await this.all();
    // D1 answers null, not undefined, for a query that matched nothing.
    const row = results[0] ?? null;
    if (column === undefined) return row;
    return row === null ? null : (row[column] ?? null);
  }

  async run() {
    const { meta, success } = await this.all();
    return { meta, success };
  }
}

/**
 * A store the src/lib/*-store.js modules can run against, backed by wrangler.
 *
 * The worker passes `env.DB` to those same functions. This is the other
 * implementation of that one interface — see the header above.
 *
 * @param {{ local?: boolean, exec?: typeof d1Execute }} [opts] `local` decides
 *   which database, explicitly, for the same reason scripts/database-target.mjs
 *   has no default: pointing a write at the wrong database is silent at the
 *   time. `exec` is a test seam and nothing else — every caller in this repo
 *   leaves it alone. It exists because the rest of this file is a shape
 *   contract with the D1 binding, and the only way to check a shape is to run
 *   it; `execFileSync` at the bottom otherwise makes that untestable without an
 *   experimental module-mocking flag on the whole `npm test` run. Same
 *   duck-typing as the store modules taking `store` rather than importing a
 *   binding.
 */
export function wranglerStore({ local = false, exec = d1Execute } = {}) {
  return {
    prepare(sql) {
      return new WranglerStatement(sql, [], local, exec);
    },
  };
}
