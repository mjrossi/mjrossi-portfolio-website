// Cloudflare Pages Function: GET /contact -> 302 mailto:
//
// Exists so the address never appears in the static HTML the site emits.
// The site is otherwise JS-free with a strict CSP; this is the single
// server-side surface (see CLAUDE.md).

const EMAIL = 'hello@mjrossi.com';

export const onRequestGet: PagesFunction = () =>
  new Response(null, {
    status: 302,
    headers: {
      Location: `mailto:${EMAIL}`,
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Robots-Tag': 'noindex, nofollow',
    },
  });
