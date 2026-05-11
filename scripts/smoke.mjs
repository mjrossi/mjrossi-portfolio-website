// Post-build smoke test. Checks static artifacts in dist/client and then
// spins up wrangler dev to hit every on-demand route. Focused on the
// handful of regressions that would be user-visible or hard to catch by
// eye — not every class name in the markup.
//
// Run after `npm run build` via `npm run smoke`.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const DIST = resolve('dist/client');
const PORT = Number(process.env.SMOKE_PORT ?? 8788);
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

// ── Static artifacts ─────────────────────────────────

if (!existsSync(DIST)) {
  console.error(`smoke: dist/client not found — run \`npm run build\` first`);
  process.exit(1);
}

for (const asset of [
  'noise.webp',
  'profile-avatar.webp',
  'favicon.svg',
  'resume.pdf',
  'og.png',
  '404.html',
  'sitemap-index.xml',
]) {
  check(`asset: ${asset}`, existsSync(resolve(DIST, asset)));
}

const astroDir = resolve(DIST, '_astro');
const cssFile = existsSync(astroDir)
  ? readdirSync(astroDir).find((f) => /^Base\..*\.css$/.test(f))
  : null;
check('css: Base.*.css exists', !!cssFile, cssFile ?? 'not found');

if (cssFile) {
  const css = readFileSync(join(astroDir, cssFile), 'utf8');
  check('css: --accent is #8f5520 (AA contrast)', /--accent:\s*#8f5520/i.test(css));
  check('css: --max token present',               /--max:\s*1100px/.test(css));
  check('css: no inline SVG data URIs',           !css.includes('data:image/svg+xml'));
  check('css: condensed masthead rules gone',
    !/\.masthead\.condensed|\.masthead-home-link|\.masthead-page-label/.test(css));
}

// ── Live routes ──────────────────────────────────────

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
  throw new Error(`smoke: wrangler dev did not become ready within ${READY_TIMEOUT_MS}ms`);
}

async function fetchRoute(path) {
  const res = await fetch(`${BASE}${path}`);
  const html = await res.text();
  return { res, html };
}

// Assertions that must hold on every on-demand HTML route
function assertSharedChrome(label, res, html, activeHref) {
  check(`${label}: 200 OK`, res.status === 200, `got ${res.status}`);
  check(
    `${label}: Cache-Control max-age=3600`,
    (res.headers.get('cache-control') ?? '').includes('max-age=3600'),
    res.headers.get('cache-control') ?? '(none)',
  );
  check(`${label}: full masthead`, html.includes('class="masthead full"'));
  check(
    `${label}: edition line (Vol. X · No. Y · Month YYYY)`,
    /Vol\. [IVXLCDM]+ · No\. [IVXLCDM]+ · \w+ \d{4}/.test(html),
  );
  check(
    `${label}: no condensed-masthead residue`,
    !/masthead condensed|masthead-home-link|masthead-page-label/.test(html),
  );
  check(
    `${label}: ContactLinks rendered twice`,
    occurrences(html, 'aria-label="Contact"') === 2,
    `found ${occurrences(html, 'aria-label="Contact"')}`,
  );
  if (activeHref) {
    const activeRx = new RegExp(
      `<a[^>]*href="${activeHref}"[^>]*class="active"|<a[^>]*class="active"[^>]*href="${activeHref}"`,
    );
    check(`${label}: nav pill active on ${activeHref}`, activeRx.test(html));
  }
}

const wrangler = spawn(
  'npx',
  ['wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'warn'],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

let exitCode = 1;
try {
  await waitForReady(`${BASE}/`, Date.now() + READY_TIMEOUT_MS);

  // Home + top-level pages
  for (const [label, path, activeHref] of [
    ['home', '/', null],
    ['work', '/work', '/work'],
    ['education', '/education', '/education'],
    ['urban-mobility', '/urban-mobility', '/urban-mobility'],
    ['blog', '/blog', '/blog'],
  ]) {
    const { res, html } = await fetchRoute(path);
    assertSharedChrome(label, res, html, activeHref);
  }

  // Blog chain: index → first post → first tag
  const blog = await fetchRoute('/blog');
  const postSlug = blog.html.match(/href="\/blog\/([^"/]+)\//)?.[1];
  const tag = blog.html.match(/href="\/blog\/tag\/([^"/]+)\//)?.[1];
  check('blog index: links to at least one post', !!postSlug);
  check('blog index: links to at least one tag',  !!tag);

  if (postSlug) {
    const post = await fetchRoute(`/blog/${postSlug}/`);
    assertSharedChrome(`blog post ${postSlug}`, post.res, post.html, '/blog');
    check(`blog post ${postSlug}: back link to /blog`, /href="\/blog"/.test(post.html));
  }

  if (tag) {
    const tagPage = await fetchRoute(`/blog/tag/${tag}/`);
    assertSharedChrome(`blog tag ${tag}`, tagPage.res, tagPage.html, '/blog');
    check(`blog tag ${tag}: lists at least one post`, /href="\/blog\/[^"/]+\//.test(tagPage.html));
  }

  // RSS
  const rss = await fetchRoute('/blog/rss.xml');
  check('rss: 200 OK',        rss.res.status === 200, `got ${rss.res.status}`);
  check('rss: has >=1 <item>', (rss.html.match(/<item>/g) || []).length >= 1);

  // /api/contact — must 302 to mailto: so the address never appears in HTML.
  // fetch() can't follow mailto:, so request with redirect: 'manual'.
  const contact = await fetch(`${BASE}/api/contact`, { redirect: 'manual' });
  check('contact: 302 redirect',    contact.status === 302, `got ${contact.status}`);
  check(
    'contact: Location is mailto:hello@mjrossi.com',
    contact.headers.get('location') === 'mailto:hello@mjrossi.com',
    contact.headers.get('location') ?? '(none)',
  );
  check(
    'contact: Cache-Control no-store',
    (contact.headers.get('cache-control') ?? '').includes('no-store'),
    contact.headers.get('cache-control') ?? '(none)',
  );

  // Every HTML response must carry a Content-Security-Policy header set by
  // src/middleware.ts. public/_headers covers static asset responses but
  // bypasses on-demand HTML routes; the middleware closes that gap. Sample
  // /blog (an on-demand HTML route) — if CSP is set here, it's set
  // everywhere assertSharedChrome runs.
  const blogCsp = blog.res.headers.get('content-security-policy') ?? '';
  check(
    'blog: Content-Security-Policy header set by middleware',
    blogCsp.length > 0,
    'no CSP on /blog response',
  );
  const scriptSrcMatch = blogCsp.match(/script-src[^;]*/i);
  check(
    'blog: CSP script-src has no unsafe-inline',
    !scriptSrcMatch || !scriptSrcMatch[0].includes("'unsafe-inline'"),
    scriptSrcMatch ? scriptSrcMatch[0] : '(no script-src directive)',
  );

  const total = passes + fails.length;
  if (fails.length === 0) {
    console.log(`smoke: PASS (${passes}/${total} checks)`);
    exitCode = 0;
  } else {
    console.error(`smoke: FAIL (${passes}/${total} checks, ${fails.length} failed)`);
    for (const f of fails) {
      console.error(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    }
  }
} catch (err) {
  console.error(`smoke: ERROR — ${err.message}`);
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
