// preview_links, for the operator CLI.
//
// The statements themselves live in src/lib/links-store.js, where the worker
// reaches them too. This file is the binder: it turns `{ local }` — the one
// thing a CLI knows and the worker does not — into a store, so every call site
// keeps the shape it has always had.
//
// Two things stay here rather than moving down, and both are about `--local`
// being a fact about which DATABASE a command was pointed at:
//
//   - clearLinks' refusal to run against production. The store module has no
//     concept of production, and the guard has to be somewhere that does.
//   - the databaseLabel-shaped decision itself, resolved by the calling script
//     through scripts/database-target.mjs before it ever reaches here.
//
// Every function below is async, because the store is. The CLI transport
// underneath is blocking (execFileSync) — see scripts/d1-store.mjs.

import * as store from '../src/lib/links-store.js';
import { wranglerStore } from './d1-store.mjs';

/** The store for one database target. */
function at(local) {
  return wranglerStore({ local });
}

// ── writes ───────────────────────────────────────────

/** @see src/lib/links-store.js */
export function recordLinks(rows, { local = false } = {}) {
  return store.recordLinks(at(local), rows);
}

/** @see src/lib/links-store.js */
export function extendLink(slug, id, exp, { local = false } = {}) {
  return store.extendLink(at(local), slug, id, exp);
}

/** @see src/lib/links-store.js */
export function extendLinks(slug, exp, { local = false } = {}) {
  return store.extendLinks(at(local), slug, exp);
}

/** @see src/lib/links-store.js */
export function revokeLinks(slug, target = {}, { local = false } = {}) {
  return store.revokeLinks(at(local), slug, target);
}

/**
 * Delete every link for the named posts. LOCAL ONLY.
 *
 * A test-fixture helper; scripts/smoke.mjs resets its rows before each run.
 * Refuses to run against production, because nothing else in this feature
 * deletes a row and an operator reaching for a delete is almost certainly
 * looking for revokeLinks instead.
 *
 * `async` so the refusal REJECTS rather than throwing synchronously. Every
 * function in this file returns a promise on the happy path, and one that
 * sometimes throws before returning it is the kind of mixed contract that works
 * under `try { await … }` and fails under `.catch(…)`.
 *
 * @see src/lib/links-store.js
 */
export async function clearLinks(slugs, { local = false } = {}) {
  if (!local) {
    throw new Error('links-db: clearLinks is local-only — use revokeLinks to withdraw a real link');
  }
  return store.clearLinks(at(true), slugs);
}

// ── reads ────────────────────────────────────────────

/** @see src/lib/links-store.js */
export function getLink(slug, id, { local = false } = {}) {
  return store.getLink(at(local), slug, id);
}

/** @see src/lib/links-store.js */
export function listLinks(slug, { local = false } = {}) {
  return store.listLinks(at(local), slug);
}

/** @see src/lib/links-store.js */
export function listAllLinks({ local = false } = {}) {
  return store.listAllLinks(at(local));
}
