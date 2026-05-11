import type { APIRoute } from 'astro';
import { securityHeaders } from '../../lib/server';

// On-demand so the address never appears in static HTML. The deployment is a
// Worker with Static Assets (not classic Pages), so Cloudflare's functions/
// is unavailable and _redirects rejects mailto: destinations — this route is
// the supported path.
export const prerender = false;

export const GET: APIRoute = () =>
  new Response(null, {
    status: 302,
    headers: {
      ...securityHeaders,
      Location: 'mailto:hello@mjrossi.com',
    },
  });
