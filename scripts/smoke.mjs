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

// Guard against accidental removal of fetchWithRetry from src/lib/server.ts.
// /api/subscribe relies on it for transient-503 resilience on the Turnstile
// siteverify and Buttondown create-subscriber calls.
const serverLibPath = resolve('src/lib/server.ts');
if (existsSync(serverLibPath)) {
  const serverLib = readFileSync(serverLibPath, 'utf8');
  check(
    'src/lib/server.ts: fetchWithRetry is exported',
    /export\s+async\s+function\s+fetchWithRetry\b/.test(serverLib),
    'fetchWithRetry export missing or renamed — /api/subscribe needs it for upstream retries',
  );
}

for (const asset of [
  'noise.webp',
  'profile-avatar.webp',
  'favicon.svg',
  'resume.pdf',
  'og.png',
  '404.html',
  'sitemap-index.xml',
  '_headers',
]) {
  check(`asset: ${asset}`, existsSync(resolve(DIST, asset)));
}

// _headers is generated post-build by scripts/gen-headers.mjs from the
// canonical CSP in src/lib/csp.js. Assert the CSP made it into the file —
// regression guard for the generator and for CSP drift between middleware
// and static-asset responses.
const headersPath = resolve(DIST, '_headers');
if (existsSync(headersPath)) {
  const headers = readFileSync(headersPath, 'utf8');
  check(
    '_headers: contains Content-Security-Policy',
    /Content-Security-Policy:\s*default-src 'none'/.test(headers),
    'CSP directive missing or wrong shape in dist/client/_headers',
  );
  check(
    "_headers: CSP allows challenges.cloudflare.com",
    headers.includes('challenges.cloudflare.com'),
    'Turnstile origin missing from static-asset CSP',
  );
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
  const contactCount = occurrences(html, 'aria-label="Contact"');
  check(
    `${label}: ContactLinks rendered twice`,
    contactCount === 2,
    `found ${contactCount}`,
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
  let homeHtml = '';
  for (const [label, path, activeHref] of [
    ['home', '/', null],
    ['work', '/work', '/work'],
    ['education', '/education', '/education'],
    ['urban-mobility', '/urban-mobility', '/urban-mobility'],
    ['blog', '/blog', '/blog'],
  ]) {
    const { res, html } = await fetchRoute(path);
    if (path === '/') homeHtml = html;
    assertSharedChrome(label, res, html, activeHref);
  }

  // Blog chain: index → first post → first tag
  const blog = await fetchRoute('/blog');
  const postSlug = blog.html.match(/href="\/blog\/(?!tag\/)([^"/]+)\//)?.[1];
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

  // Newsletter form on /blog only (and the /api/subscribe sad paths).
  check(
    'blog index: newsletter form present',
    /id="newsletter-form"/.test(blog.html),
  );
  check(
    'blog index: Turnstile script tag',
    /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/.test(blog.html),
  );

  // CSP must be set on the HTML response (via middleware, since public/_headers
  // doesn't apply to on-demand routes on Workers+Assets). Without this, the
  // page ships with no CSP and any browser/extension-injected policy wins.
  const blogCsp = blog.res.headers.get('content-security-policy') ?? '';
  check(
    'blog: Content-Security-Policy header set',
    blogCsp.length > 0,
    'no CSP on /blog response',
  );
  check(
    'blog: CSP allows challenges.cloudflare.com',
    blogCsp.includes('challenges.cloudflare.com'),
    blogCsp || '(none)',
  );
  // script-src must NOT include 'unsafe-inline'. style-src is allowed to
  // (Astro/Vite inline a few style declarations), so check the directive
  // in isolation rather than the whole CSP string.
  const scriptSrcMatch = blogCsp.match(/script-src[^;]*/i);
  check(
    'blog: CSP keeps script-src strict (no unsafe-inline)',
    !!scriptSrcMatch && !scriptSrcMatch[0].includes("'unsafe-inline'"),
    scriptSrcMatch ? scriptSrcMatch[0] : '(no script-src directive)',
  );
  // Submit handler must ship as an EXTERNAL module from /scripts/newsletter.js
  // (a static asset under public/scripts/). An inline script would require
  // 'unsafe-inline' in CSP, which we deliberately don't allow.
  check(
    'blog: submit handler is external (/scripts/newsletter.js)',
    /<script[^>]+src=["']\/scripts\/newsletter\.js["']/i.test(blog.html),
    'no external /scripts/newsletter.js <script src> found in blog HTML',
  );
  check(
    'blog: submit handler is not inlined',
    !/<script[^>]*>[^<]*newsletter-form[^<]*<\/script>/i.test(blog.html),
    'an inline script referencing newsletter-form is still present',
  );

  // The subscription fallback line ("Or follow by RSS · email me") must live
  // OUTSIDE the .newsletter <aside> so ad-block filter lists that target the
  // newsletter card don't hide it too. Regression guard against re-inlining
  // the fallback into the form fineprint.
  const followNoteIdx = blog.html.indexOf('class="blog-follow-note"');
  const newsletterCloseIdx = blog.html.indexOf('</aside>');
  check(
    'blog: follow note present',
    followNoteIdx > 0,
    'no blog-follow-note paragraph found',
  );
  check(
    'blog: follow note is OUTSIDE the newsletter aside',
    followNoteIdx > 0 && newsletterCloseIdx > 0 && followNoteIdx > newsletterCloseIdx,
    'blog-follow-note appears inside .newsletter — ad blockers will hide it',
  );
  const afterAside = blog.html.slice(newsletterCloseIdx);
  check(
    'blog: follow note class name doesn\'t trip ad-block filters',
    !/class="[^"]*(newsletter|subscribe|signup|email-form|mailing-list)[^"]*"/.test(afterAside) ||
    /class="blog-follow-note"/.test(afterAside),
    'after </aside>, found an ad-block-magnet class name on a sibling',
  );
  check(
    'home: no newsletter form (JS carve-out scoped to /blog)',
    !/id="newsletter-form"/.test(homeHtml),
  );
  check(
    'home: no Turnstile script',
    !/challenges\.cloudflare\.com\/turnstile/.test(homeHtml),
  );

  // /api/subscribe sad paths — happy path needs a real Turnstile token
  // (or Turnstile's documented test secret in .dev.vars) so it's not in CI.
  // Astro's built-in CSRF protection (security.checkOrigin) rejects POSTs
  // without a matching Origin at the framework layer, so all the assertions
  // below pass an Origin header to exercise our handler rather than
  // Astro's middleware. (A missing Origin would correctly 403 — that's
  // the desired browser-facing behavior, just not what we're asserting here.)
  const ORIGIN = { Origin: BASE };

  // Helper: explicitly drain the response body (so connection releases promptly)
  // and retry once on 5xx (wrangler dev / workerd has been observed returning
  // transient 503s under rapid serial POSTs in CI; local is more forgiving).
  // Smoke shouldn't fail on infrastructure flakes — we're asserting our
  // endpoint's contract, not workerd's reliability.
  async function fetchExpectingNon5xx(url, init) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, init);
      await res.text(); // drain body, release connection
      if (res.status < 500) return res;
      // 5xx — workerd transient. Wait briefly and retry.
      await new Promise((r) => setTimeout(r, 200));
    }
    // Final attempt — return whatever, let the assertion fail with the status
    const res = await fetch(url, init);
    await res.text();
    return res;
  }

  const getSub = await fetchExpectingNon5xx(`${BASE}/api/subscribe`, { method: 'GET', headers: ORIGIN });
  check('subscribe: 405 on GET', getSub.status === 405, `got ${getSub.status}`);

  const txtSub = await fetchExpectingNon5xx(`${BASE}/api/subscribe`, {
    method: 'POST',
    headers: { ...ORIGIN, 'Content-Type': 'text/plain' },
    body: 'hi',
  });
  check('subscribe: 415 on non-JSON', txtSub.status === 415, `got ${txtSub.status}`);

  const badEmail = await fetchExpectingNon5xx(`${BASE}/api/subscribe`, {
    method: 'POST',
    headers: { ...ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'not-an-email', turnstileToken: 'x' }),
  });
  check('subscribe: 400 on invalid email', badEmail.status === 400, `got ${badEmail.status}`);

  const noToken = await fetchExpectingNon5xx(`${BASE}/api/subscribe`, {
    method: 'POST',
    headers: { ...ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'a@b.co' }),
  });
  check(
    'subscribe: 400 on missing turnstile token',
    noToken.status === 400,
    `got ${noToken.status}`,
  );

  // Astro's built-in CSRF protection (security.checkOrigin) rejects
  // form-encoded POSTs without a matching Origin at the framework layer.
  // JSON POSTs require browser preflight and reach the handler regardless,
  // so this assertion specifically targets the form-style attack vector.
  const noOrigin = await fetchExpectingNon5xx(`${BASE}/api/subscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'email=a@b.co',
  });
  check(
    'subscribe: 403 on form-encoded POST w/o Origin (CSRF guard)',
    noOrigin.status === 403,
    `got ${noOrigin.status}`,
  );

  // Honeypot — a filled `company` field returns 200 silently so attackers
  // can't tell the field exists. Runs before Turnstile so the token is irrelevant.
  const honeypot = await fetchExpectingNon5xx(`${BASE}/api/subscribe`, {
    method: 'POST',
    headers: { ...ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'bot@example.com', turnstileToken: 'x', company: 'ACME Corp' }),
  });
  check('subscribe: 200 on filled honeypot field', honeypot.status === 200, `got ${honeypot.status}`);

  // /privacy must exist and name the third parties so the form fineprint
  // links to a real disclosure.
  const privacy = await fetchRoute('/privacy');
  check('privacy: 200 OK', privacy.res.status === 200, `got ${privacy.res.status}`);
  check('privacy: names Buttondown', /Buttondown/i.test(privacy.html));
  check('privacy: names Turnstile', /Turnstile/i.test(privacy.html));

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
