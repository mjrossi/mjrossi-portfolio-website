// Canonical Content Security Policy for the site. Imported by:
//   - src/middleware.ts (applies it to every on-demand HTML response)
//   - scripts/gen-headers.mjs (writes it into dist/client/_headers so the
//     Cloudflare ASSETS binding serves the same policy on static asset
//     responses)
//
// Plain JS (not TS) so both Astro/Vite (src/) and a vanilla Node script
// (scripts/) can import it without TypeScript tooling on the Node side.
// The export is a single string constant — no runtime logic, no need for
// type annotations.
//
// Turnstile (https://challenges.cloudflare.com) is allow-listed for
// script-src, connect-src, and frame-src so the widget loads on /blog.
// Browsers only fetch from Turnstile where a <script src> exists in markup
// — i.e. /blog only — so the allow-list is global but the actual fetches
// are scoped to the one route that ships the form.

export const CSP = [
  "default-src 'none'",
  "script-src 'self' https://challenges.cloudflare.com",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self'",
  "font-src 'self'",
  "connect-src 'self' https://challenges.cloudflare.com",
  "frame-src https://challenges.cloudflare.com",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "require-trusted-types-for 'script'",
  'upgrade-insecure-requests',
].join('; ');
