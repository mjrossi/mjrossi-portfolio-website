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
// rather than a subtly different behaviour.

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
  constructor(sql, params, local) {
    this.sql = sql;
    this.params = params;
    this.local = local;
  }

  bind(...params) {
    return new WranglerStatement(this.sql, params, this.local);
  }

  async all() {
    const { results, meta } = d1Execute(renderSql(this.sql, this.params), { local: this.local });
    return { results, meta, success: true };
  }

  async first() {
    const { results } = await this.all();
    // D1 answers null, not undefined, for a query that matched nothing.
    return results[0] ?? null;
  }

  async run() {
    const { meta } = await this.all();
    return { meta, success: true };
  }
}

/**
 * A store the src/lib/*-store.js modules can run against, backed by wrangler.
 *
 * The worker passes `env.DB` to those same functions. This is the other
 * implementation of that one interface — see the header above.
 *
 * @param {{ local?: boolean }} [opts] which database, decided explicitly by the
 *   caller. There is no default here for the same reason there is none in
 *   scripts/database-target.mjs: pointing a write at the wrong database is
 *   silent at the time.
 */
export function wranglerStore({ local = false } = {}) {
  return {
    prepare(sql) {
      return new WranglerStatement(sql, [], local);
    },
  };
}
