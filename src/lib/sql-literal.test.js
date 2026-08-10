import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSql, sqlLiteral } from './sql-literal.js';

// The escaping boundary for every statement the operator CLI runs. See
// sql-literal.js for why it is not in scripts/.

// ── sqlLiteral ───────────────────────────────────────

test('null and undefined both render as NULL', () => {
  assert.equal(sqlLiteral(null), 'NULL');
  assert.equal(sqlLiteral(undefined), 'NULL');
});

test('integers render bare, including negatives and zero', () => {
  assert.equal(sqlLiteral(0), '0');
  assert.equal(sqlLiteral(1758000000), '1758000000');
  assert.equal(sqlLiteral(-1), '-1');
});

test('a non-integer number is refused rather than rounded', () => {
  // Every numeric column here is an epoch or a line number. A float means the
  // caller computed it wrong, and rounding would store the mistake.
  assert.throws(() => sqlLiteral(1.5), /must be an integer/);
  assert.throws(() => sqlLiteral(NaN), /must be an integer/);
  assert.throws(() => sqlLiteral(Infinity), /must be an integer/);
});

test('a plain string is quoted', () => {
  assert.equal(sqlLiteral('why-im-pivoting'), "'why-im-pivoting'");
});

test("a quote is doubled, which is SQLite's own escape", () => {
  assert.equal(sqlLiteral("it's"), "'it''s'");
  assert.equal(sqlLiteral("''"), "''''''");
});

test('a backslash is left alone', () => {
  // SQLite gives backslash no meaning inside a literal. Escaping it would
  // corrupt reviewer prose, which is exactly what passes through here.
  assert.equal(sqlLiteral('a\\b'), "'a\\b'");
  assert.equal(sqlLiteral("\\'"), "'\\'''");
});

test('newlines and unicode survive verbatim', () => {
  assert.equal(sqlLiteral('one\ntwo'), "'one\ntwo'");
  assert.equal(sqlLiteral('— … 日本語'), "'— … 日本語'");
});

test('a NUL byte is refused, because execve would truncate it', () => {
  assert.throws(() => sqlLiteral('a\0b'), /NUL byte/);
});

test('types that reach no column here are refused rather than coerced', () => {
  assert.throws(() => sqlLiteral(true), /unsupported type boolean/);
  assert.throws(() => sqlLiteral({}), /unsupported type object/);
  assert.throws(() => sqlLiteral([1]), /unsupported type object/);
});

test('the message names which parameter, one-based', () => {
  assert.throws(() => sqlLiteral(true, 2), /parameter 3/);
});

// ── renderSql ────────────────────────────────────────

test('placeholders are substituted in order', () => {
  assert.equal(
    renderSql('SELECT * FROM t WHERE a = ? AND b = ?', ['x', 7]),
    "SELECT * FROM t WHERE a = 'x' AND b = 7",
  );
});

test('a statement with no placeholders needs no parameters', () => {
  assert.equal(renderSql('SELECT 1'), 'SELECT 1');
  assert.equal(renderSql('SELECT 1', []), 'SELECT 1');
});

test('a ? inside a string literal is data, not a placeholder', () => {
  assert.equal(renderSql("SELECT '?', ?", ['x']), "SELECT '?', 'x'");
});

test('an escaped quote does not end the literal it is inside', () => {
  // The bug this pins: treating '' as a close-then-open would put the scanner
  // outside the string, and the ? after it would be substituted.
  assert.equal(renderSql("SELECT 'a''?b', ?", [1]), "SELECT 'a''?b', 1");
});

test('a substituted value containing ? is not re-scanned', () => {
  // The value is appended to the output, never re-read, so a reviewer writing
  // "why?" cannot consume the next parameter.
  assert.equal(renderSql('SELECT ?, ?', ['why?', 2]), "SELECT 'why?', 2");
});

test('too few parameters throws rather than dropping placeholders', () => {
  assert.throws(() => renderSql('SELECT ?, ?', [1]), /more \? placeholders/);
});

test('too many parameters throws rather than ignoring the extras', () => {
  // The quiet one: a spare parameter usually means the statement lost a column,
  // and SQLite would accept the shortened row without complaint.
  assert.throws(() => renderSql('SELECT ?', [1, 2]), /2 parameters bound/);
});

test('an unterminated string literal throws', () => {
  assert.throws(() => renderSql("SELECT 'oops", []), /unterminated string literal/);
});

test('a multi-row INSERT renders every tuple', () => {
  assert.equal(
    renderSql('INSERT INTO t (a, b) VALUES (?, ?), (?, ?)', ['x', 1, "y'z", null]),
    "INSERT INTO t (a, b) VALUES ('x', 1), ('y''z', NULL)",
  );
});

test('a bad parameter fails the whole render, leaving no partial statement', () => {
  assert.throws(() => renderSql('INSERT INTO t VALUES (?, ?)', ['ok', true]), /unsupported type/);
});
