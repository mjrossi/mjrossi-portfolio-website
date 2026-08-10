// Which paths are the Desk.
//
// One function rather than an inline `startsWith('/admin')`, because THREE
// places have to agree on the answer and two of them are not code this repo
// runs: src/middleware.ts (the gate), astro.config.mjs (keeping /admin out of
// the sitemap), and the path pattern on the Cloudflare Access application. A
// mismatch between the first two is a draft inventory listed in a public
// sitemap; a mismatch with the third is a Desk the edge does not protect.
//
// The trap is the same one isPreviewHost has with its leading dot: a bare
// `startsWith('/admin')` also matches `/administrator` and `/admin-notes`, so a
// future public page whose slug merely begins with those letters would be
// silently 404ed for everyone without an Access token. Matching requires the
// segment to END, which means `/admin` exactly or `/admin/` followed by
// anything.
//
// Plain JS so `node --test`, the worker, and astro.config.mjs can all import it.

/** The one prefix, so nothing below spells it twice. Not exported: `isAdminPath`
 *  is the whole of what the three callers need, and a second export invites a
 *  fourth place to compose its own answer out of it. */
const ADMIN_ROOT = '/admin';

/**
 * Is this pathname part of the Desk?
 *
 * Trailing slashes are accepted in both directions (`/admin` and `/admin/`),
 * because Astro will happily serve either and a gate that covered only one is a
 * gate with a documented bypass.
 *
 * Case-sensitive, deliberately. Cloudflare Access matches paths case-sensitively
 * too, so treating `/ADMIN` as the Desk here would create a path this code
 * protects and the edge does not — which is exactly backwards from the direction
 * a disagreement should fail in. `/ADMIN` simply has no route and 404s on its
 * own.
 *
 * @param {string} pathname
 * @returns {boolean}
 */
export function isAdminPath(pathname) {
  if (typeof pathname !== 'string') return false;
  return pathname === ADMIN_ROOT || pathname.startsWith(`${ADMIN_ROOT}/`);
}
