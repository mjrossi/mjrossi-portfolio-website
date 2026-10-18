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
import { SECURITY_HEADERS } from '../src/lib/security-headers.js';

// The non-CSP headers come from src/lib/security-headers.js so this file and
// src/middleware.ts can't drift — same reason the CSP lives in csp.js.
// /scripts/theme.js is the one render-blocking asset: Base.astro loads it
// synchronously in <head> on every page. Cloudflare's static-asset default is
// to revalidate on every request, which put a 304 round-trip in front of every
// first paint. An hour matches the HTML's own max-age, so a change to the
// script reaches readers on the same schedule as the pages that load it.
const HEADERS = `/*
  Content-Security-Policy: ${CSP}
${Object.entries(SECURITY_HEADERS)
  .map(([name, value]) => `  ${name}: ${value}`)
  .join('\n')}

/scripts/theme.js
  Cache-Control: public, max-age=3600
`;

const outDir = resolve('dist/client');
if (!existsSync(outDir)) {
  console.error(`gen-headers: ${outDir} not found — run \`astro build\` first`);
  process.exit(1);
}

const outPath = resolve(outDir, '_headers');
writeFileSync(outPath, HEADERS, 'utf8');
console.log(`gen-headers: wrote ${outPath} (${HEADERS.length} bytes)`);
