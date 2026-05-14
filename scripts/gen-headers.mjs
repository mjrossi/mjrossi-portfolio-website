// Post-build: write dist/client/_headers from the canonical CSP in
// src/lib/csp.js plus the rest of the static security-header set. Replaces
// the static public/_headers file so the CSP can't drift between middleware
// (HTML responses) and static-asset responses.
//
// Runs as part of `npm run build` (see package.json). If this script fails
// or dist/client/_headers ends up missing/empty, the smoke test asserts on
// its presence and CSP content — that catches the regression immediately.

import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CSP } from '../src/lib/csp.js';

const HEADERS = `/*
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Content-Security-Policy: ${CSP}
  Cross-Origin-Opener-Policy: same-origin
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()
`;

const outDir = resolve('dist/client');
if (!existsSync(outDir)) {
  console.error(`gen-headers: ${outDir} not found — run \`astro build\` first`);
  process.exit(1);
}

const outPath = resolve(outDir, '_headers');
writeFileSync(outPath, HEADERS, 'utf8');
console.log(`gen-headers: wrote ${outPath} (${HEADERS.length} bytes)`);
