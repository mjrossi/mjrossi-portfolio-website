// The non-CSP security headers, shared by src/middleware.ts (every worker
// response) and scripts/gen-headers.mjs (static assets). Middleware sets them
// only when absent, so /api/*'s stricter values win.
//
// Referrer-Policy is load-bearing: preview tokens ride in URLs, and
// `unsafe-url` would hand every review link to every site a draft links to.

export const SECURITY_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000; includeSubDomains',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy':
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
};
