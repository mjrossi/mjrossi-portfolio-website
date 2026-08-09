// The one place this repo shells out to `wrangler d1 execute`.
//
// Every caller needs the same three things — spawn wrangler, strip the banner it
// sometimes prints before its JSON, and tell the operator to migrate when the
// table isn't there. Before this module the operator scripts hand-rolled all
// three, once each.
//
// The SQL itself is no longer written against these functions. It lives in
// src/lib/links-store.js and src/lib/notes-store.js in ordinary D1 idiom
// (`prepare(sql).bind(...params)`), so the worker and this CLI run the same
// statements; scripts/d1-store.mjs is the façade that renders those bound
// parameters back into a `--command` string, because wrangler's CLI has no
// parameters at all. This file is the transport under that façade and nothing
// more.
//
// D1 is reached through wrangler rather than the HTTP API because wrangler is
// already authenticated as the operator. That is the same reasoning that keeps
// the deployed Worker free of any admin WRITE surface — see
// scripts/galley-pull.mjs.
//
// These functions THROW; they never process.exit. Each script keeps its own
// die() prefix so a failure still names the tool the operator actually ran.

import { execFileSync } from 'node:child_process';

/** The D1 database. Holds galley_notes and preview_links. */
export const DB_NAME = 'mjrossi-galley';

function migrateAdvice(local) {
  return local
    ? '  Has the local database been migrated?\n' +
        `    npx wrangler d1 migrations apply ${DB_NAME} --local`
    : '  Is wrangler logged in with a D1:Edit token, and the remote database migrated?\n' +
        `    npx wrangler d1 migrations apply ${DB_NAME} --remote`;
}

/**
 * Why this reads stdout on failure: under `--json`, wrangler prints the D1
 * error as a JSON document on STDOUT and leaves stderr empty, so the useful
 * half ("no such table: preview_links") is not where a shell-out normally looks
 * for it. Reporting only err.message gives the operator "Command failed" and
 * the full argv, which is exactly unhelpful for the failure they will actually
 * hit — running before `d1 migrations apply`.
 */
function failureDetail(err) {
  for (const stream of [err.stderr, err.stdout]) {
    const text = stream?.toString().trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(extractJson(text));
      const inner = parsed?.error?.text ?? parsed?.error?.message;
      if (inner) return inner;
    } catch {
      // Not JSON — it is wrangler's pretty output, which is what the non-JSON
      // command (d1Migrate) produces. Strip the presentation so the
      // operator reads one line of cause rather than a wall of escape codes:
      // ANSI colours, the ✘/[ERROR] furniture, and the "Logs were written to"
      // trailer, which points at a file that says the same thing again.
    }
    const cleaned = text
      // eslint-disable-next-line no-control-regex
      .replace(/\[[0-9;]*m/g, '')
      .split('\n')
      .map((line) => line.replace(/^\s*✘\s*\[ERROR\]\s*/, '').trimEnd())
      .filter((line) => line.trim() && !line.includes('Logs were written to'))
      .join('\n');
    if (cleaned) return cleaned;
  }
  return err.message;
}

function wrangler(args, local) {
  try {
    return execFileSync('npx', ['wrangler', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    throw new Error(`could not reach D1: ${failureDetail(err)}\n${migrateAdvice(local)}`);
  }
}

/**
 * wrangler prints a banner before the JSON on some versions. Take from the
 * first LINE that opens a JSON document rather than from the first `[` anywhere
 * — a banner containing a bracket (a log level, a version range, a path) would
 * otherwise start the slice mid-sentence and produce a parse error describing
 * the banner instead of the real problem.
 *
 * @param {string} text
 */
export function extractJson(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return trimmed;
  const lines = trimmed.split('\n');
  const start = lines.findIndex((line) => /^\s*[[{]/.test(line));
  return start === -1 ? trimmed : lines.slice(start).join('\n');
}

/**
 * Run one statement and return wrangler's whole result object for it —
 * `{ results, success, meta }`, the same shape a D1 binding's `.run()` reports.
 *
 * Exists so scripts/d1-store.mjs can present a D1-compatible façade over this
 * CLI, including `meta.changes`. d1Query below is the thin "just the rows" case,
 * which is what every caller wanted before that façade existed.
 *
 * @param {string} sql
 * @param {{ local?: boolean }} [opts]
 * @returns {{ results: Record<string, unknown>[], meta?: Record<string, unknown> }}
 */
export function d1Execute(sql, { local = false } = {}) {
  const raw = wrangler(
    ['d1', 'execute', DB_NAME, local ? '--local' : '--remote', '--json', '--command', sql],
    local,
  );
  // Parsed OUTSIDE the call above, so a wrangler output-format change reports
  // itself rather than borrowing the "have you migrated?" advice, which would
  // send the operator to a database that was never the problem.
  let parsed;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    throw new Error(
      `wrangler returned output this script could not parse as JSON: ${err.message}\n` +
        `  first 200 characters were: ${JSON.stringify(raw.slice(0, 200))}`,
    );
  }
  // Valid JSON in the wrong shape is its own failure, and it must not resolve to
  // an empty result set. `[0]?.results ?? []` would turn a future wrangler that
  // wraps its output differently into "this query matched nothing" -- silently,
  // and with exit code 0. preview-roster.mjs is the only inventory of issued
  // links there is, so an empty list from it has to mean the table is empty
  // rather than that this parse gave up.
  if (!Array.isArray(parsed) || !parsed[0] || !Array.isArray(parsed[0].results)) {
    throw new Error(
      'wrangler returned JSON in a shape this script does not recognise ' +
        '(expected [{ results: [...] }]).\n' +
        `  first 200 characters were: ${JSON.stringify(raw.slice(0, 200))}`,
    );
  }
  return parsed[0];
}

/**
 * Run a read and return its rows.
 *
 * @param {string} sql
 * @param {{ local?: boolean }} [opts]
 * @returns {Record<string, unknown>[]}
 */
export function d1Query(sql, { local = false } = {}) {
  return d1Execute(sql, { local }).results;
}

/**
 * Apply migrations/. `wrangler dev` does NOT do this on startup — it just hands
 * the worker an empty local database — which is why scripts/smoke.mjs calls it
 * before spawning.
 *
 * @param {{ local?: boolean }} [opts]
 */
export function d1Migrate({ local = false } = {}) {
  wrangler(['d1', 'migrations', 'apply', DB_NAME, local ? '--local' : '--remote'], local);
}
