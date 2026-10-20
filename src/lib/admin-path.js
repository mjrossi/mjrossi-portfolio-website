// Which paths are the Desk.
//
// One function because three things must agree: src/middleware.ts (the gate),
// the sitemap filter in astro.config.mjs, and the Cloudflare Access app's path
// pattern. A bare `startsWith('/admin')` would also match `/administrator`.

const ADMIN_ROOT = '/admin';

/**
 * Is this pathname part of the Desk? `/admin` or anything under `/admin/`.
 *
 * Case-sensitive, like Access. Matching `/ADMIN` here would create a path this
 * code protects and the edge does not; it has no route and 404s anyway.
 *
 * @param {string} pathname already decoded (Astro normalises before middleware)
 * @returns {boolean}
 */
export function isAdminPath(pathname) {
  if (typeof pathname !== 'string') return false;
  return pathname === ADMIN_ROOT || pathname.startsWith(`${ADMIN_ROOT}/`);
}
