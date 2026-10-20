// Post-build: write dist/client/_headers from csp.js and security-headers.js,
// so static assets get the same policy as middleware gives HTML. Smoke asserts
// the file exists and carries the CSP.

import { writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { CSP } from '../src/lib/csp.js';
import { SECURITY_HEADERS } from '../src/lib/security-headers.js';

// /scripts/theme.js is render-blocking on every page, and the asset default
// revalidates each request: a 304 before every first paint. An hour, like the HTML.
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
