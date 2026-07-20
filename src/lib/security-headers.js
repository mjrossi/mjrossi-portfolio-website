// Canonical non-CSP security header set for the site. Imported by:
//   - src/middleware.ts (applies it to every response the worker generates)
//   - scripts/gen-headers.mjs (writes it into dist/client/_headers so the
//     Cloudflare ASSETS binding serves the same set on static assets)
//
// Plain JS (not TS) for the same reason as csp.js — both Astro/Vite (src/)
// and a vanilla Node script (scripts/) import it without TypeScript tooling
// on the Node side.
//
// CSP lives in csp.js, not here: it is applied only to HTML responses by
// middleware, whereas this set applies to everything the worker emits.
//
// Middleware applies these with set-if-absent semantics, so a route that has
// deliberately chosen a stricter value keeps it — /api/* responses built via
// src/lib/server.ts send `Referrer-Policy: no-referrer` and
// `Cache-Control: no-store`, and those must not be widened by the default.

export const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
};
