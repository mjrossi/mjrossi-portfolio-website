// Read one variable from .dev.vars, the way wrangler would. Shared by
// preview-link.mjs and smoke, which MUST agree byte-for-byte: if one stripped
// quotes and the other didn't, every positive preview assertion would fail
// locally while CI (no .dev.vars) passed. Flat KEY=value only.

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * @param {string} name variable to look up
 * @param {string} [path] defaults to ./.dev.vars
 * @returns {string | null} the value, or null if absent/empty/no file
 */
export function readDevVar(name, path = resolve('.dev.vars')) {
  if (!existsSync(path)) return null;
  const rx = new RegExp(`^\\s*${name}\\s*=\\s*(.*)$`, 'm');
  const raw = readFileSync(path, 'utf8').match(rx)?.[1];
  if (raw === undefined) return null;
  // Trim first, then strip one layer of matching surrounding quotes.
  const value = raw.trim().replace(/^(["'])(.*)\1$/, '$2');
  return value ? value : null;
}
