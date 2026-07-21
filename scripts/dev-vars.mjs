// Read a single variable out of .dev.vars, the way wrangler would.
//
// Shared by scripts/preview-link.mjs (which signs preview tokens) and
// scripts/smoke.mjs (which signs tokens the worker must then verify). Those
// two MUST agree byte-for-byte: if one strips surrounding quotes and the other
// doesn't, `PREVIEW_SIGNING_KEY="abc"` gives smoke a key of `"abc"` while
// wrangler hands the worker `abc`, and every positive-path preview assertion
// fails locally while CI — which has no .dev.vars — passes. That is exactly
// the flake this file exists to make impossible, so parse in one place only.
//
// Deliberately minimal: no export/comment/multiline-value handling, because
// .dev.vars in this repo is a flat KEY=value list. Match wrangler's dotenv
// behaviour for the shapes we actually use, not the whole format.

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
