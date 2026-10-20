// A D1-compatible façade over `wrangler d1 execute`, so the statements in
// src/lib/links-store.js and notes-store.js run unchanged from the CLI.
// wrangler's `--command` has no parameters, so they are rendered into the text
// by src/lib/sql-literal.js — THE ESCAPING BOUNDARY.
//
// Deliberately partial: bind, all, first and run, nothing else, so a caller
// reaching for more gets a TypeError rather than different behaviour. What it
// does implement must match D1's signatures (hence `first(column)`).
//
// One gap: D1 caps a statement at 100 bound parameters and rendered text
// doesn't. recordLinks binds 7 per row, seedNotes 14; chunk any future batch.

import { renderSql } from '../src/lib/sql-literal.js';
import { d1Execute } from './d1.mjs';

/**
 * A prepared statement, shaped like D1's. `bind` returns a new statement, as D1
 * does. Async on the outside so the stores await both paths; blocking inside.
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
    // wrangler's own `success`: hardcoding true would read a failure as success.
    const { results, meta, success } = this.exec(renderSql(this.sql, this.params), {
      local: this.local,
    });
    return { results, meta, success: success ?? true };
  }

  /**
  /**
   * @param {string} [column] D1's overload: that column's value, not the row.
   *   Returning the row instead would be silent and truthy.
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
 * A store the src/lib/*-store.js modules can run against, backed by wrangler;
 * the worker passes `env.DB` to the same functions.
 *
 * @param {{ local?: boolean, exec?: typeof d1Execute }} [opts] `exec` is a test
 *   seam only, so the shape contract can be checked without module mocking.
 */
export function wranglerStore({ local = false, exec = d1Execute } = {}) {
  return {
    prepare(sql) {
      return new WranglerStatement(sql, [], local, exec);
    },
  };
}
