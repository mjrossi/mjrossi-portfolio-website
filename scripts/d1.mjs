// The one place this repo shells out to `wrangler d1 execute`: spawn it, strip
// any banner before its JSON, and point at migrations when a table is missing.
// The transport under scripts/d1-store.mjs; wrangler is already authenticated
// as the operator. Throws, never exits, so each script's die() names the tool.

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
 * Under `--json`, wrangler puts the D1 error on STDOUT with stderr empty, so
 * read both — or the operator gets "Command failed" for a missing migration.
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
      // Not JSON (d1Migrate's pretty output): strip ANSI, the ✘/[ERROR]
      // furniture and the "Logs were written to" trailer down to one cause.
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
 * Take from the first LINE that opens a JSON document, not the first `[`: a
 * banner with a bracket in it would otherwise start the slice mid-sentence.
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
 * Run one statement and return wrangler's whole result — `{ results, success,
 * meta }`, the shape a D1 binding reports — for d1-store.mjs's façade.
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
  // Parsed outside the call, so a format change isn't blamed on migrations.
  let parsed;
  try {
    parsed = JSON.parse(extractJson(raw));
  } catch (err) {
    throw new Error(
      `wrangler returned output this script could not parse as JSON: ${err.message}\n` +
        `  first 200 characters were: ${JSON.stringify(raw.slice(0, 200))}`,
    );
  }
  // The wrong shape must not read as "no rows": the roster is the only
  // inventory, so empty has to mean empty.
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
 * Apply migrations/. `wrangler dev` doesn't, so smoke calls this first.
 *
 * @param {{ local?: boolean }} [opts]
 */
export function d1Migrate({ local = false } = {}) {
  wrangler(['d1', 'migrations', 'apply', DB_NAME, local ? '--local' : '--remote'], local);
}
