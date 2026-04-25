import type { APIRoute } from 'astro';

// On-demand endpoint so the address never appears in static HTML.
// Cloudflare _redirects rejects mailto: destinations, and the deployment
// is a Worker with Static Assets (not classic Pages), so functions/ is
// also unavailable. This route runs in the Astro Cloudflare worker.
export const prerender = false;

export const GET: APIRoute = () =>
  new Response(null, {
    status: 302,
    headers: {
      Location: 'mailto:hello@mjrossi.com',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
