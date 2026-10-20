// Rendering bound parameters into SQL text: THE ESCAPING BOUNDARY for every
// statement the CLI runs. The statements in links-store.js / notes-store.js use
// `?` placeholders, which the worker's D1 binding takes as parameters; wrangler's
// `--command` takes only a string, so this closes the gap. The worker never
// calls it.

/**
 * One value as a SQLite literal: null/undefined → NULL, integers → digits,
 * strings → quoted with `''`. Anything else throws.
 *
 * Non-integers are refused because every numeric column is an epoch or a line
 * number. Backslash is NOT escaped: SQLite gives it no meaning in a literal,
 * and escaping it would corrupt reviewer prose. A NUL byte is refused because
 * it cannot survive execve into wrangler's argv.
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
 * Scans rather than `.replace(/\?/g, …)`, so a `?` inside a quoted literal
 * (including after a `''` escape) is left alone.
 *
 * The count is checked in both directions: a mismatch is not a SQL error, it
 * slides values into the wrong columns.
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
          // `''`: consume both, stay inside the literal.
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
    // The scan lost track of string boundaries, so its substitutions can't be trusted.
    throw new Error('sql-literal: statement has an unterminated string literal');
  }
  if (used !== params.length) {
    throw new Error(
      `sql-literal: ${params.length} parameters bound but the statement has ${used} ? placeholders`,
    );
  }
  return out;
}
