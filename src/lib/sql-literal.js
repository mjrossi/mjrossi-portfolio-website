// Rendering bound parameters into a SQL string. THE ESCAPING BOUNDARY for every
// statement this repo runs from the CLI.
//
// The statements themselves live in links-store.js and notes-store.js, written
// once in D1 idiom with `?` placeholders so the worker and the operator CLI run
// the same copy. The worker's D1 binding takes those parameters as parameters.
// wrangler's `--command` cannot: it takes a string. This module is what closes
// that gap, and it is therefore the only place in the repo where a value ends up
// inside SQL text rather than beside it.
//
// SPLIT OUT OF scripts/d1-store.mjs so `node --test` can reach it, on exactly the
// argument that moved galley-relocate.js and galley-manifest.js out of their
// scripts. That façade is where the wrangler shell-out lives; this is the part
// with something to get wrong. The failure modes are a mis-escaped quote (a
// syntax error at best, an injected statement at worst) and a placeholder count
// that silently slides every subsequent value into the wrong column — the second
// being the quiet one, since SQLite will often accept the result.
//
// The WORKER never calls this. Nothing on the request path interpolates
// anything.

/**
 * One value as a SQLite literal.
 *
 * Three types reach a statement in this repo, and anything else is a bug worth
 * hearing about rather than coercing:
 *
 *   null/undefined  → NULL
 *   number          → the digits, integers only
 *   string          → quoted, with SQLite's own '' escape
 *
 * Non-integer numbers are refused because nothing here stores one: every numeric
 * column is an epoch (seconds for `exp`, milliseconds for the rest) or a line
 * number, and a float arriving at one of them means a caller computed it wrong.
 * Refusing is how that gets noticed.
 *
 * Quote-doubling is the ONLY transformation applied to a string. SQLite gives
 * backslash no special meaning inside a literal, so escaping it would corrupt
 * reviewer prose rather than protect anything — and reviewer prose is exactly
 * what passes through here.
 *
 * A NUL byte is refused outright: it cannot survive execve into wrangler's argv,
 * so a value carrying one would be truncated somewhere between here and the
 * database with nothing to say so.
 *
 * @param {unknown} value
 * @param {number} index zero-based, for the message only
 * @returns {string}
 */
export function sqlLiteral(value, index = 0) {
  const where = `parameter ${index + 1}`;
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error(`sql-literal: ${where} must be an integer, got ${JSON.stringify(value)}`);
    }
    return String(value);
  }
  if (typeof value === 'string') {
    if (value.includes('\0')) {
      throw new Error(`sql-literal: ${where} contains a NUL byte, which wrangler cannot carry`);
    }
    return `'${value.replace(/'/g, "''")}'`;
  }
  throw new Error(
    `sql-literal: ${where} has unsupported type ${typeof value} — ` +
      'statements here take strings, integers and null',
  );
}

/**
 * Substitute bound parameters into a statement.
 *
 * Scans rather than doing a bare `.replace(/\?/g, …)`, because a `?` inside a
 * quoted literal is data and must be left alone. No statement in this repo
 * carries one today — every value is a parameter — but the scanner costs a few
 * lines and removes the need for whoever adds the first one to know that. It
 * also has to understand `''`, SQLite's escape for a quote inside a string,
 * or the first escaped quote would look like the end of the literal and every
 * `?` after it would be substituted as if it were a placeholder.
 *
 * THE COUNT IS CHECKED IN BOTH DIRECTIONS and a mismatch throws. That is the
 * error worth engineering for: too few placeholders and the extra values are
 * dropped, too many and every subsequent value lands one column to the left.
 * Neither is a SQL error, so without this the row is simply wrong.
 *
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {string}
 */
export function renderSql(sql, params = []) {
  let out = '';
  let used = 0;
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      out += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          // An escaped quote: consume both and stay inside the literal.
          out += sql[++i];
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === '?') {
      if (used >= params.length) {
        throw new Error(
          `sql-literal: statement has more ? placeholders than the ${params.length} bound`,
        );
      }
      out += sqlLiteral(params[used], used);
      used++;
      continue;
    }
    out += ch;
  }
  if (inString) {
    // Unbalanced quotes mean the scan above lost track of which side of a string
    // it was on, so the substitution it just did cannot be trusted. Every
    // statement in this repo is a string literal in a source file, so this is a
    // typo rather than input — but it is one that would otherwise produce a
    // command that silently means something else.
    throw new Error('sql-literal: statement has an unterminated string literal');
  }
  if (used !== params.length) {
    throw new Error(
      `sql-literal: ${params.length} parameters bound but the statement has ${used} ? placeholders`,
    );
  }
  return out;
}
