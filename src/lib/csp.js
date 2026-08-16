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
// script-src, connect-src, and frame-src so the widget loads where the
// newsletter form does. Browsers only fetch from Turnstile where a <script src>
// exists in markup, so the allow-list is global but the actual fetches are
// scoped to the routes that ship the form.
//
// That set is WIDER than it was. It used to be /blog alone; the August 2026
// review's placement D put the subscribe card at the foot of every PUBLISHED
// post, so the fetches now happen there too. The policy itself is unchanged and
// still correct — this note is about blast radius, which is the thing a reader
// comes to a CSP file to size up, so it has to keep saying something true.
// Drafts are still excluded: BlogPost.astro gates the card on `!scheduled`, and
// scripts/smoke/live-preview.mjs asserts it.

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
