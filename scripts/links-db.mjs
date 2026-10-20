// preview_links for the operator CLI: binds `{ local }` to a store. The SQL is
// src/lib/links-store.js. clearLinks' local-only guard lives here, because only
// the CLI knows which database it was pointed at.

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
 * Delete every link for the named posts. LOCAL ONLY; smoke's fixture reset. An
 * operator reaching for a delete wants revokeLinks.
 *
 * Async so the refusal REJECTS: a function that sometimes throws before
 * returning its promise works under `await` and fails under `.catch`.
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
export function getLinkById(id, { local = false } = {}) {
  return store.getLinkById(at(local), id);
}

/** @see src/lib/links-store.js */
export function listLinks(slug, { local = false } = {}) {
  return store.listLinks(at(local), slug);
}

/** @see src/lib/links-store.js */
export function listAllLinks({ local = false } = {}) {
  return store.listAllLinks(at(local));
}
