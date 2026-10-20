import { defineMiddleware } from 'astro:middleware';
import { CSP } from './lib/csp.js';
import { SECURITY_HEADERS } from './lib/security-headers.js';
import { isPreviewHost, verifyPreviewGrant } from './lib/preview.js';
import { isLinkActive } from './lib/preview-links.js';
import { verifyAccessJwt } from './lib/access.js';
import { isAdminPath } from './lib/admin-path.js';
import { refuse, tryGetEnv } from './lib/server.ts';

// Every worker response passes through here. dist/client/_headers covers only
// ASSETS-binding responses, so on-demand routes (every page, the RSS feed,
// /api/*) get their headers from this file. Header values live in csp.js and
// security-headers.js, shared with scripts/gen-headers.mjs.
//
// Security headers are set only when absent, so a route's stricter value wins
// (/api/* sends `no-referrer` and `no-store`). HTML defaults to an hour of
// edge cache.
//
// Three gates resolve here, before the route runs, and all fail closed:
//   - /admin: a verified Access JWT (see access.js), or a 404 — not a 403, so
//     the Desk's existence is not confirmed.
//   - *.workers.dev preview hosts reveal every scheduled post.
//   - `?preview=<token>`: signature, then the preview_links allowlist. The
//     normal request path does no HMAC work and no D1 read.

export const onRequest = defineMiddleware(async (context, next) => {
  const admin = isAdminPath(context.url.pathname);
  if (admin) {
    const env = tryGetEnv();
    // The header, not the CF_Authorization cookie: the edge sets it on every
    // proxied request, while a browser can be talked into sending a cookie.
    const grant = await verifyAccessJwt(context.request.headers.get('Cf-Access-Jwt-Assertion'), {
      teamDomain: env?.ACCESS_TEAM_DOMAIN,
      aud: env?.ACCESS_AUD,
      jwksOverride: env?.ACCESS_JWKS_OVERRIDE,
    });
    if (!grant) {
      // `refuse` drains any body: this answers every method on every /admin
      // path, and undrained bodies take `wrangler dev` down (see server.ts).
      return await refuse(
        context.request,
        new Response('Not found', {
          status: 404,
          headers: {
            ...SECURITY_HEADERS,
            'Content-Type': 'text/plain; charset=utf-8',
            'Cache-Control': 'no-store',
            'X-Robots-Tag': 'noindex, nofollow',
          },
        }),
      );
    }
    context.locals.admin = grant;
  }

  const showScheduled = isPreviewHost(context.url.hostname);

  const token = context.url.searchParams.get('preview');
  let previewSlug: string | null = null;
  let previewReviewer: string | null = null;
  if (token) {
    const env = tryGetEnv();
    const grant = await verifyPreviewGrant(token, env?.PREVIEW_SIGNING_KEY);
    // Revoking takes reading as well as writing: both locals stay null and the
    // post 404s.
    if (grant && (await isLinkActive(env?.DB, grant.linkId))) {
      previewSlug = grant.slug;
      // Null for a view-only link; /api/galley refuses to write without it.
      previewReviewer = grant.reviewer;
    }
  }

  context.locals.showScheduled = showScheduled;
  context.locals.previewSlug = previewSlug;
  context.locals.previewReviewer = previewReviewer;

  const response = await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!response.headers.has(name)) response.headers.set(name, value);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('text/html')) {
    response.headers.set('Content-Security-Policy', CSP);
    if (!response.headers.has('Cache-Control')) {
      response.headers.set('Cache-Control', 'public, max-age=3600');
    }
  }

  // A response that may carry a draft is never cached or indexed. These two
  // OVERRIDE, the one place this file does: the values already present (the
  // hour above, the RSS route's own) are exactly what must not apply. The Desk
  // is here too — a cached copy would be the whole draft inventory at the edge.
  if (showScheduled || previewSlug || admin) {
    response.headers.set('Cache-Control', 'no-store');
    response.headers.set('X-Robots-Tag', 'noindex, nofollow');
  }

  return response;
});
