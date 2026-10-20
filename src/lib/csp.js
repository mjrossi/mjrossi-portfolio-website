// The site's Content Security Policy, shared by src/middleware.ts (on-demand
// HTML) and scripts/gen-headers.mjs (dist/client/_headers for static assets).
//
// Turnstile is allow-listed globally, but browsers only fetch it where the
// subscribe form's <script> is: /blog and the foot of every PUBLISHED post.
// Drafts never get the form; smoke asserts it.

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
