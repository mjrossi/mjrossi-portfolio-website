// Post-build smoke test for the on-demand home route. The home page
// renders in the Cloudflare worker (src/pages/index.astro sets
// prerender = false), so it can't be asserted by reading dist/client
// like scripts/smoke.mjs does. This script starts wrangler dev, fetches
// the route, runs the same assertions, and shuts down.
//
// Run after `npm run build` via `npm run worker-smoke`.
import { spawn } from 'node:child_process';

const PORT = Number(process.env.WORKER_SMOKE_PORT ?? 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 30_000;

const fails = [];
let passes = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passes++;
    return;
  }
  fails.push({ name, detail });
}

function occurrences(haystack, needle) {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

async function waitForReady(url, deadline) {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status) return;
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`worker-smoke: wrangler dev did not become ready within ${READY_TIMEOUT_MS}ms`);
}

const wrangler = spawn(
  'npx',
  ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'warn'],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

let exitCode = 1;
try {
  await waitForReady(`${BASE}/`, Date.now() + READY_TIMEOUT_MS);

  const res = await fetch(`${BASE}/`);
  const html = await res.text();

  check('home: 200 OK', res.status === 200, `got ${res.status}`);
  check(
    'home: Cache-Control public, max-age=3600',
    (res.headers.get('cache-control') ?? '').includes('max-age=3600'),
    res.headers.get('cache-control') ?? '(none)',
  );

  // Mirrors the assertions previously in scripts/smoke.mjs for dist/client/index.html
  check('home: full masthead',          html.includes('class="masthead full"'));
  check('home: masthead-inner wrapper', html.includes('class="masthead-inner"'));
  check('home: masthead-meta-loc',      html.includes('masthead-meta-loc'));
  check('home: masthead-meta-edition',  html.includes('masthead-meta-edition'));
  check(
    'home: edition line format (Vol. X · No. Y · Month YYYY)',
    /Vol\. [IVXLCDM]+ · No\. [IVXLCDM]+ · \w+ \d{4}/.test(html),
  );
  check('home: broadsheet-body',        html.includes('class="broadsheet-body"'));
  check('home: col-about',              html.includes('col-about'));
  check('home: col-now',                html.includes('col-now'));
  check('home: drop cap',               html.includes('class="dropcap"'));
  check('home: avatar img',             /<img[^>]*class="[^"]*avatar/.test(html));
  check('home: footer structure',
    html.includes('broadsheet-footer') &&
    html.includes('broadsheet-colophon') &&
    html.includes('footer-contact') &&
    html.includes('nav-contact'),
  );
  check(
    'home: ContactLinks rendered twice (nav + footer)',
    occurrences(html, 'aria-label="Contact"') === 2,
    `found ${occurrences(html, 'aria-label="Contact"')}`,
  );
  check('home: nav has Blog link', /href="\/blog"[^>]*>\s*Blog\s*</.test(html));

  const total = passes + fails.length;
  if (fails.length === 0) {
    console.log(`worker-smoke: PASS (${passes}/${total} checks)`);
    exitCode = 0;
  } else {
    console.error(`worker-smoke: FAIL (${passes}/${total} checks, ${fails.length} failed)`);
    for (const f of fails) {
      console.error(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    }
  }
} catch (err) {
  console.error(`worker-smoke: ERROR — ${err.message}`);
} finally {
  wrangler.kill('SIGTERM');
  await new Promise((r) => {
    wrangler.once('exit', r);
    setTimeout(() => {
      wrangler.kill('SIGKILL');
      r();
    }, 3000);
  });
  process.exit(exitCode);
}
