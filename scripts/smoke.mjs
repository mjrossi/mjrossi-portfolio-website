// Post-build smoke test. Checks static artifacts in dist/client and then
// spins up wrangler dev to hit every on-demand route. Focused on the
// handful of regressions that would be user-visible or hard to catch by
// eye — not every class name in the markup.
//
// Run after `npm run build` via `npm run smoke`.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { request as httpRequest } from 'node:http';
import { signPreviewToken, WORKER_NAME } from '../src/lib/preview.js';
import { readDevVar } from './dev-vars.mjs';

const DIST = resolve('dist/client');
const PORT = Number(process.env.SMOKE_PORT ?? 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 30_000;

// The permanently-future-dated post in src/content/blog/. Everything in the
// scheduled-post matrix below keys off it.
const FIXTURE_SLUG = 'smoke-scheduled-fixture';
const FIXTURE_TAG = 'smoke-fixture';

// Sign with whatever key the worker will actually hold. wrangler dev reads
// .dev.vars and that wins over --var, so a developer with a real key there
// would otherwise see the positive-path assertions fail locally while CI
// (no .dev.vars) passed — the worst kind of flake. Mirror the precedence,
// using the same parser scripts/preview-link.mjs signs with so quoting can't
// drift between them.
const devVarsKey = readDevVar('PREVIEW_SIGNING_KEY');
const PREVIEW_KEY = devVarsKey ?? 'smoke-only-preview-signing-key';
// Only inject a key when .dev.vars didn't supply one.
const PREVIEW_KEY_ARGS = devVarsKey ? [] : ['--var', `PREVIEW_SIGNING_KEY:${PREVIEW_KEY}`];

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

// Strip // and /* */ comments so source-grep assertions match real code.
// Without this, a comment *explaining* that an identifier is deliberately
// absent trips the very check asserting its absence.
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// Substring-match a response header. Returns false for missing headers so
// the failure message points at the assertion rather than throwing.
function headerContains(res, name, value) {
  return (res.headers.get(name) ?? '').includes(value);
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

// Guard the scheduled-publishing wiring. src/lib/schedule.test.js proves the
// predicate is correct, but nothing there would catch getPublishedPosts()
// simply not calling it — delete the filter and the unit tests stay green
// while every scheduled post silently publishes. Assert the call site exists.
const blogLibPath = resolve('src/lib/blog.ts');
if (existsSync(blogLibPath)) {
  const blogLib = readFileSync(blogLibPath, 'utf8');
  check(
    'src/lib/blog.ts: getPublishedPosts filters via isPublished',
    /isPublished\s*\(/.test(blogLib) && /showScheduled/.test(blogLib),
    'scheduled-publishing filter missing from getPublishedPosts — future-dated posts would publish early',
  );
}

// Same reasoning for the scoped preview unlock: src/lib/preview.test.js proves
// the signature and expiry logic, but dropping the previewSlug branch from the
// post route would break every signed link with all tests still green.
const postRoutePath = resolve('src/pages/blog/[...slug].astro');
if (existsSync(postRoutePath)) {
  // Comments stripped so the route's own explanatory comment can't satisfy
  // this on its own — the identifier has to appear in real code.
  const postRoute = stripComments(readFileSync(postRoutePath, 'utf8'));
  check(
    'blog post route: honours previewSlug',
    /previewSlug/.test(postRoute),
    'scoped preview unlock missing from [...slug].astro — signed preview links would 404',
  );
}

// The preview unlock must never widen beyond the post's own URL. If
// previewSlug ever reaches the listing helpers, a shared preview link could
// inject an unpublished post into the RSS feed — which is what triggers
// Buttondown's email to real subscribers. Assert it stays out.
// Comments are stripped first: both files *document* why previewSlug is
// absent, and that prose would otherwise trip the check asserting its absence.
const blogLibSource = existsSync(blogLibPath) ? stripComments(readFileSync(blogLibPath, 'utf8')) : '';
check(
  'src/lib/blog.ts: previewSlug does NOT reach the listing helpers',
  !/previewSlug/.test(blogLibSource),
  'previewSlug leaked into blog.ts — a signed preview link could reach the index/tags/RSS',
);
const rssRoutePath = resolve('src/pages/blog/rss.xml.ts');
if (existsSync(rssRoutePath)) {
  check(
    'rss route: previewSlug does NOT reach the feed',
    !/previewSlug/.test(stripComments(readFileSync(rssRoutePath, 'utf8'))),
    'previewSlug leaked into the RSS route — a preview link could trigger the subscriber email',
  );
}

// isPreviewHost tells the production workers.dev alias apart from a preview
// one purely by comparing the first hostname label to WORKER_NAME. If the
// Worker were renamed in wrangler.jsonc without updating preview.js, that
// comparison would stop matching and the live site's own alias would start
// serving every scheduled draft, RSS included. Same drift-prevention rationale
// as the shared csp.js / security-headers.js modules.
const wranglerConfig = resolve('wrangler.jsonc');
if (existsSync(wranglerConfig)) {
  const raw = readFileSync(wranglerConfig, 'utf8');
  const configuredName = stripComments(raw).match(/"name"\s*:\s*"([^"]+)"/)?.[1];
  check(
    'preview.js WORKER_NAME matches wrangler.jsonc name',
    configuredName === WORKER_NAME,
    `wrangler.jsonc name=${configuredName ?? '(none)'} vs preview.js WORKER_NAME=${WORKER_NAME}`,
  );
  check(
    'wrangler.jsonc disables the production workers.dev alias',
    /"workers_dev"\s*:\s*false/.test(stripComments(raw)),
    'workers_dev is not set to false — the production alias would expose scheduled drafts',
  );
}

// Every binding the deployed Worker carries must be declared in wrangler.jsonc.
//
// The build does NOT deploy wrangler.jsonc — it deploys dist/server/wrangler.json,
// which @astrojs/cloudflare generates from it and is free to add to. It already
// does: when `config.session.driver` is unset the adapter injects a SESSION KV
// binding unconditionally, which is how a KV namespace came to exist in the
// account without this repo mentioning it. That is invisible locally — the
// binding only shows up in generated output and the Cloudflare dashboard — so
// without this check the next adapter release can quietly add another one and
// nothing fails until someone audits the account by hand.
//
// Compares binding NAMES only. Secrets never appear in the generated config
// (`vars` is `{}` and there is no secret list), so this cannot leak one or trip
// over a missing .dev.vars.
function bindingNames(config) {
  const names = new Set();
  if (config?.assets?.binding) names.add(config.assets.binding);
  for (const key of [
    'kv_namespaces',
    'd1_databases',
    'r2_buckets',
    'services',
    'workflows',
    'hyperdrive',
    'vectorize',
    'analytics_engine_datasets',
    'mtls_certificates',
    'dispatch_namespaces',
  ]) {
    for (const entry of config?.[key] ?? []) if (entry?.binding) names.add(entry.binding);
  }
  // Durable Objects and send_email key the binding as `name`, not `binding`.
  for (const entry of config?.durable_objects?.bindings ?? []) if (entry?.name) names.add(entry.name);
  for (const entry of config?.send_email ?? []) if (entry?.name) names.add(entry.name);
  for (const entry of config?.queues?.producers ?? []) if (entry?.binding) names.add(entry.binding);
  if (config?.ai?.binding) names.add(config.ai.binding);
  return names;
}

const generatedConfig = resolve('dist/server/wrangler.json');
if (existsSync(wranglerConfig) && existsSync(generatedConfig)) {
  let declared;
  let generated;
  try {
    // stripComments only removes lines that START with `//`, so URLs inside
    // string values survive. Trailing commas are legal in JSONC but not JSON,
    // so drop them too rather than failing on a legal config.
    const asJson = stripComments(readFileSync(wranglerConfig, 'utf8')).replace(/,(\s*[}\]])/g, '$1');
    declared = bindingNames(JSON.parse(asJson));
    generated = bindingNames(JSON.parse(readFileSync(generatedConfig, 'utf8')));
  } catch (err) {
    declared = null;
    check('wrangler configs parse as JSON', false, String(err));
  }
  if (declared) {
    const undeclared = [...generated].filter((name) => !declared.has(name));
    check(
      'wrangler.jsonc declares every binding in the built worker',
      undeclared.length === 0,
      `${undeclared.join(', ')} present in dist/server/wrangler.json but not declared in wrangler.jsonc` +
        ' — the deployed Worker would carry a binding this repo never wrote down',
    );
  }
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

// Astro's emitted CSS filename is an internal detail, not a contract. 7.1.3
// shipped this bundle twice — Base.<hash>.css from the SSR build and
// 404-astro-<hash>.css from the prerender build — because /404 is prerendered
// and every other route is SSR, and both pull global.css through Base.astro.
// 7.1.4 deduplicated them, keeping only the prerender name (withastro/astro
// #17488), which failed a check pinned to `Base.*.css` on a patch bump that
// changed nothing user-visible. Match on the extension instead, and assert
// against every stylesheet shipped so the negative guards below can't be
// dodged by a rule landing in a second bundle.
const astroDir = resolve(DIST, '_astro');
const cssFiles = existsSync(astroDir)
  ? readdirSync(astroDir).filter((f) => f.endsWith('.css'))
  : [];
check('css: a stylesheet is emitted to _astro/', cssFiles.length > 0, 'no .css file found');

// Not guarded by `cssFiles.length` — when no bundle is found these must fail,
// not silently skip. The condensed-masthead rule is a regression guard, and a
// guard that vanishes from the run whenever the CSS can't be located is worse
// than no guard at all: the suite stays green through exactly the build
// breakage it exists to catch.
const css = cssFiles.map((f) => readFileSync(join(astroDir, f), 'utf8')).join('\n');
check('css: --accent is #8f5520 (AA contrast)', /--accent:\s*#8f5520/i.test(css));
check('css: --max token present',               /--max:\s*1100px/.test(css));
check('css: no inline SVG data URIs',           !css.includes('data:image/svg+xml'));
// Guards a prior masthead design (condensed variant + home-link/page-label
// bar) that was reverted. The rules below assert those classes never
// reappear in the built CSS or rendered HTML — without these, a copy-paste
// from the old design could ship unnoticed.
check('css: condensed masthead rules gone',
  !/\.masthead\.condensed|\.masthead-home-link|\.masthead-page-label/.test(css));

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
    headerContains(res, 'cache-control', 'max-age=3600'),
    res.headers.get('cache-control') ?? '(none)',
  );
  check(`${label}: full masthead`, html.includes('class="masthead full"'));
  check(
    `${label}: edition line (Vol. X · No. Y · Month YYYY)`,
    /Vol\. [IVXLCDM]+ · No\. [IVXLCDM]+ · \w+ \d{4}/.test(html),
  );
  // See the matching css-side guard above — same prior-design regression.
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
  [
    'wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'warn',
    ...PREVIEW_KEY_ARGS,
  ],
  { stdio: ['ignore', 'ignore', 'inherit'] },
);

let exitCode = 1;
try {
  await waitForReady(`${BASE}/`, Date.now() + READY_TIMEOUT_MS);

  // Home + top-level pages, fetched in parallel — they're independent GETs
  // and wrangler-dev parallelism noticeably shaves wall time over a serial loop.
  const topRoutes = [
    ['home', '/', null],
    ['work', '/work', '/work'],
    ['projects', '/projects', '/projects'],
    ['education', '/education', '/education'],
    ['urban-mobility', '/urban-mobility', '/urban-mobility'],
    ['blog', '/blog', '/blog'],
  ];
  const topResults = await Promise.all(topRoutes.map(([, path]) => fetchRoute(path)));
  let homeHtml = '';
  let blog = null;
  topResults.forEach(({ res, html }, i) => {
    const [label, path, activeHref] = topRoutes[i];
    if (path === '/') homeHtml = html;
    if (path === '/blog') blog = { res, html };
    assertSharedChrome(label, res, html, activeHref);
  });

  // Blog chain: pick a post + a tag off the index, then fetch both in parallel.
  const postSlug = blog.html.match(/href="\/blog\/(?!tag\/)([^"/]+)\//)?.[1];
  const tag = blog.html.match(/href="\/blog\/tag\/([^"/]+)\//)?.[1];
  check('blog index: links to at least one post', !!postSlug);
  check('blog index: links to at least one tag',  !!tag);

  const [post, tagPage, rss] = await Promise.all([
    postSlug ? fetchRoute(`/blog/${postSlug}/`) : Promise.resolve(null),
    tag ? fetchRoute(`/blog/tag/${tag}/`) : Promise.resolve(null),
    fetchRoute('/blog/rss.xml'),
  ]);

  if (post) {
    assertSharedChrome(`blog post ${postSlug}`, post.res, post.html, '/blog');
    check(`blog post ${postSlug}: back link to /blog`, /href="\/blog"/.test(post.html));
  }

  // Lock in the <Figure> contract: the Netherlands cycling post embeds three
  // <Figure> components, each of which must render a <figcaption>. If this
  // count drifts, either the component broke or the post was edited.
  const figurePost = await fetchRoute('/blog/how-the-netherlands-got-me-back-on-a-bike/');
  check(
    'blog post (figures): renders >=3 figcaption elements',
    (figurePost.html.match(/<figcaption>/g) || []).length >= 3,
    `found ${(figurePost.html.match(/<figcaption>/g) || []).length}`,
  );

  if (tagPage) {
    assertSharedChrome(`blog tag ${tag}`, tagPage.res, tagPage.html, '/blog');
    check(`blog tag ${tag}: lists at least one post`, /href="\/blog\/[^"/]+\//.test(tagPage.html));
  }

  // RSS
  check('rss: 200 OK',        rss.res.status === 200, `got ${rss.res.status}`);
  check('rss: has >=1 <item>', (rss.html.match(/<item>/g) || []).length >= 1);
  // RSS is on-demand (not prerendered), so it sets its own Cache-Control since
  // middleware only touches text/html responses.
  check(
    'rss: Cache-Control max-age=3600',
    headerContains(rss.res, 'cache-control', 'max-age=3600'),
    rss.res.headers.get('cache-control') ?? '(none)',
  );
  // Going on-demand moved RSS out of the ASSETS binding, so it no longer
  // inherits dist/client/_headers — middleware must supply the security set
  // on non-HTML worker responses. Spot-check two; if these are missing the
  // middleware regressed to HTML-only gating.
  check(
    'rss: X-Content-Type-Options nosniff',
    headerContains(rss.res, 'x-content-type-options', 'nosniff'),
    rss.res.headers.get('x-content-type-options') ?? '(none)',
  );
  check(
    'rss: Strict-Transport-Security present',
    headerContains(rss.res, 'strict-transport-security', 'max-age='),
    rss.res.headers.get('strict-transport-security') ?? '(none)',
  );
  // Scheduled-publishing invariant: the production feed must never contain a
  // post whose pubDate is still in the future. Guards the date filter in
  // getPublishedPosts() against regressions (this holds for all time, so it
  // won't rot as fixture dates pass).
  const rssNow = Date.now();
  const rssDates = [...rss.html.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map((m) =>
    Date.parse(m[1]),
  );
  // Assert parseability separately — filtering NaN out silently would let a
  // malformed <pubDate> pass the future-date check rather than fail it.
  check(
    'rss: every pubDate parses',
    rssDates.every(Number.isFinite),
    `${rssDates.filter((t) => !Number.isFinite(t)).length} unparseable pubDate(s)`,
  );
  const futureRssItems = rssDates.filter((t) => Number.isFinite(t) && t > rssNow);
  check('rss: no future-dated items', futureRssItems.length === 0, `${futureRssItems.length} future item(s)`);

  // Preview unlock must fail closed. 127.0.0.1 is not a preview host (that's
  // deliberate — it keeps every assertion above on the production code path),
  // and no key can produce this signature, so a garbage token must change
  // nothing at all. If either guard regressed, the response would flip to
  // no-store and start carrying X-Robots-Tag.
  const bogus = await fetch(`${BASE}/blog?preview=some-draft.9999999999.deadbeef`);
  const bogusHtml = await bogus.text();
  check('preview: invalid token still 200', bogus.status === 200, `got ${bogus.status}`);
  check(
    'preview: invalid token does not disable caching',
    headerContains(bogus, 'cache-control', 'max-age=3600'),
    bogus.headers.get('cache-control') ?? '(none)',
  );
  check(
    'preview: invalid token reveals no scheduled post',
    !bogusHtml.includes('post-scheduled'),
    'a Scheduled badge rendered for an unsigned token',
  );
  // A malformed token must not 500 the route either — verifyPreviewToken
  // swallows every parse failure and returns null.
  const malformed = await fetch(`${BASE}/blog?preview=%2E%2E%2F..%2Fetc`);
  check('preview: malformed token does not error', malformed.status === 200, `got ${malformed.status}`);

  // ── Scheduled-post matrix ──────────────────────────
  // The source-greps above prove previewSlug never reaches blog.ts or the RSS
  // route, but a leak introduced in index.astro or tag/[tag].astro would slip
  // past every one of them. These four cases close that gap against a real
  // future-dated post, over HTTP, on the production code path (127.0.0.1 is
  // deliberately not a preview host).
  const fixtureExp = Math.floor(Date.now() / 1000) + 3600;
  const fixtureToken = await signPreviewToken(FIXTURE_SLUG, fixtureExp, PREVIEW_KEY);
  const q = `preview=${encodeURIComponent(fixtureToken)}`;

  // 1. Locked: hidden everywhere, 404 at its own URL.
  const [lockedIndex, lockedTag, lockedRss, lockedPost] = await Promise.all([
    fetch(`${BASE}/blog`).then((r) => r.text()),
    fetch(`${BASE}/blog/tag/${FIXTURE_TAG}`),
    fetch(`${BASE}/blog/rss.xml`).then((r) => r.text()),
    fetch(`${BASE}/blog/${FIXTURE_SLUG}/`),
  ]);
  check('scheduled: fixture absent from /blog', !lockedIndex.includes(FIXTURE_SLUG));
  check('scheduled: fixture absent from RSS', !lockedRss.includes(FIXTURE_SLUG));
  check('scheduled: fixture URL 404s', lockedPost.status === 404, `got ${lockedPost.status}`);
  // getAllTags only sees published posts, so the tag page must not exist.
  check('scheduled: fixture-only tag page 404s', lockedTag.status === 404, `got ${lockedTag.status}`);

  // 2. Unlocked with a valid token — the post's OWN url only.
  const unlocked = await fetch(`${BASE}/blog/${FIXTURE_SLUG}/?${q}`);
  const unlockedHtml = await unlocked.text();
  check('preview: valid token opens the scheduled post', unlocked.status === 200, `got ${unlocked.status}`);
  check('preview: unlocked post shows the Scheduled badge', unlockedHtml.includes('post-scheduled'));
  check(
    'preview: unlocked post is no-store',
    headerContains(unlocked, 'cache-control', 'no-store'),
    unlocked.headers.get('cache-control') ?? '(none)',
  );
  check(
    'preview: unlocked post is noindex',
    headerContains(unlocked, 'x-robots-tag', 'noindex'),
    unlocked.headers.get('x-robots-tag') ?? '(none)',
  );

  // 3. THE load-bearing direction: that same valid token must not widen the
  // listing surfaces. RSS is the one that matters most — it drives Buttondown's
  // email to real subscribers, so a link handed to a reviewer reaching it would
  // publish the post for real.
  const [tokenIndex, tokenRss] = await Promise.all([
    fetch(`${BASE}/blog?${q}`).then((r) => r.text()),
    fetch(`${BASE}/blog/rss.xml?${q}`).then((r) => r.text()),
  ]);
  check(
    'preview: valid token does NOT add the post to /blog',
    !tokenIndex.includes(FIXTURE_SLUG),
    'a signed preview link widened the blog index',
  );
  check(
    'preview: valid token does NOT add the post to RSS',
    !tokenRss.includes(FIXTURE_SLUG),
    'a signed preview link reached the feed — this would trigger the subscriber email',
  );

  // 4. A token minted for one slug must not open a DIFFERENT post's URL.
  // The slug is inside the signed payload, and [...slug].astro compares
  // previewSlug to the post it is rendering — this asserts that comparison
  // over HTTP. src/lib/preview.test.js covers slug *tampering* (which breaks
  // the signature); this covers the case the signature can't catch on its own,
  // a perfectly valid token presented at the wrong URL.
  //
  // Deliberately NOT written as "valid token, some already-published post,
  // expect 200": that passes with or without a token, so it can never fail
  // for the reason it claims to test.
  const wrongSlugToken = await signPreviewToken('some-other-draft', fixtureExp, PREVIEW_KEY);
  const wrongSlug = await fetch(`${BASE}/blog/${FIXTURE_SLUG}/?preview=${encodeURIComponent(wrongSlugToken)}`);
  check(
    'preview: a token minted for another slug does not open the fixture',
    wrongSlug.status === 404,
    `got ${wrongSlug.status} — a signed token unlocked a post it was not minted for`,
  );

  // An expired token must 404 the post exactly like no token at all.
  const expiredToken = await signPreviewToken(FIXTURE_SLUG, Math.floor(Date.now() / 1000) - 60, PREVIEW_KEY);
  const expired = await fetch(`${BASE}/blog/${FIXTURE_SLUG}/?preview=${encodeURIComponent(expiredToken)}`);
  check('preview: expired token 404s the scheduled post', expired.status === 404, `got ${expired.status}`);

  // ── Host-based unlock (both directions) ────────────
  // isPreviewHost is unit-tested as a pure function, and everything above runs
  // on 127.0.0.1 (deliberately not a preview host). Neither proves the signal
  // is actually WIRED UP: revert a call site to getPublishedPosts() with no
  // argument and the whole suite stays green while PR previews silently stop
  // showing drafts. Fail-closed, so not a leak — but a dead feature nobody
  // would notice. These requests set Host so the worker sees a preview
  // hostname, which is also a live demonstration of the caveat in CLAUDE.md:
  // the unlock's strength is Cloudflare's routing, not this code.
  // NOTE: this cannot use fetch(). Node's fetch (undici) silently overwrites
  // the Host header with the URL's origin, so `headers: { host }` is dropped
  // and every assertion below would test 127.0.0.1 again — the negative ones
  // would still pass, which is precisely how a broken version of this test
  // looks healthy. node:http sends what it is given.
  const asHost = (path, hostname) =>
    new Promise((ok, fail) => {
      const req = httpRequest(
        { host: '127.0.0.1', port: PORT, path, method: 'GET', headers: { Host: hostname } },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (body += c));
          // Minimal fetch-Response shape so these read like the rest of the file.
          res.on('end', () =>
            ok({
              status: res.statusCode,
              headers: {
                get: (n) => {
                  const v = res.headers[n.toLowerCase()];
                  return Array.isArray(v) ? v.join(', ') : (v ?? null);
                },
              },
              text: async () => body,
            }),
          );
        },
      );
      req.on('error', fail);
      req.end();
    });

  const PREVIEW_HOST = `smoke-${WORKER_NAME}.example.workers.dev`;
  const [previewIndex, previewRss, previewPost] = await Promise.all([
    asHost('/blog', PREVIEW_HOST),
    asHost('/blog/rss.xml', PREVIEW_HOST),
    asHost(`/blog/${FIXTURE_SLUG}/`, PREVIEW_HOST),
  ]);
  const previewIndexHtml = await previewIndex.text();
  check(
    'preview host: reveals the scheduled fixture on /blog',
    previewIndexHtml.includes(FIXTURE_SLUG),
    'a *.workers.dev preview host did not show the scheduled post — the showScheduled wiring may be broken',
  );
  check(
    'preview host: /blog is no-store',
    headerContains(previewIndex, 'cache-control', 'no-store'),
    previewIndex.headers.get('cache-control') ?? '(none)',
  );
  check(
    'preview host: /blog is noindex',
    headerContains(previewIndex, 'x-robots-tag', 'noindex'),
    previewIndex.headers.get('x-robots-tag') ?? '(none)',
  );
  check('preview host: fixture URL 200s', previewPost.status === 200, `got ${previewPost.status}`);
  check(
    'preview host: RSS includes the scheduled fixture',
    (await previewRss.text()).includes(FIXTURE_SLUG),
    'the host unlock is meant to widen RSS too (unlike a signed link)',
  );
  check(
    'preview host: RSS is no-store',
    headerContains(previewRss, 'cache-control', 'no-store'),
    previewRss.headers.get('cache-control') ?? '(none)',
  );

  // The negative twin: the Worker's OWN workers.dev alias serves production on
  // a hostname anyone can derive from this repo, so it must NOT unlock. Only
  // proven at the unit level until now.
  const PROD_ALIAS_HOST = `${WORKER_NAME}.example.workers.dev`;
  const [aliasIndex, aliasRss] = await Promise.all([
    asHost('/blog', PROD_ALIAS_HOST),
    asHost('/blog/rss.xml', PROD_ALIAS_HOST),
  ]);
  check(
    'production workers.dev alias: does NOT reveal the fixture on /blog',
    !(await aliasIndex.text()).includes(FIXTURE_SLUG),
    'the production alias unlocked scheduled drafts — isPreviewHost regressed',
  );
  check(
    'production workers.dev alias: does NOT reveal the fixture in RSS',
    !(await aliasRss.text()).includes(FIXTURE_SLUG),
    'the production alias leaked a draft into the feed — this would trigger the subscriber email',
  );
  check(
    'production workers.dev alias: still cacheable',
    headerContains(aliasIndex, 'cache-control', 'max-age=3600'),
    aliasIndex.headers.get('cache-control') ?? '(none)',
  );

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
    headerContains(contact, 'cache-control', 'no-store'),
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
  const jsonPost = (body) => ({
    method: 'POST',
    headers: { ...ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

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

  // Sad-path matrix: every entry exercises a distinct contract on
  // /api/subscribe. Honeypot must come after happy-path-shaped inputs
  // because its 200 response is the contract — not an empty pass.
  const subscribeCases = [
    {
      name: '405 on GET',
      init: { method: 'GET', headers: ORIGIN },
      expect: 405,
    },
    {
      name: '415 on non-JSON',
      init: { method: 'POST', headers: { ...ORIGIN, 'Content-Type': 'text/plain' }, body: 'hi' },
      expect: 415,
    },
    {
      name: '400 on invalid email',
      init: jsonPost({ email: 'not-an-email', turnstileToken: 'x' }),
      expect: 400,
    },
    {
      name: '400 on missing turnstile token',
      init: jsonPost({ email: 'a@b.co' }),
      expect: 400,
    },
    {
      // Astro's built-in CSRF protection (security.checkOrigin) rejects
      // form-encoded POSTs without a matching Origin at the framework layer.
      // JSON POSTs require browser preflight and reach the handler regardless,
      // so this assertion specifically targets the form-style attack vector.
      name: '403 on form-encoded POST w/o Origin (CSRF guard)',
      init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a@b.co' },
      expect: 403,
    },
    {
      // Honeypot — a filled `company` field returns 200 silently so attackers
      // can't tell the field exists. Runs before Turnstile so the token is irrelevant.
      name: '200 on filled honeypot field',
      init: jsonPost({ email: 'bot@example.com', turnstileToken: 'x', company: 'ACME Corp' }),
      expect: 200,
    },
  ];

  // Run the subscribe matrix + the realistic-payload guard + the privacy fetch
  // in parallel — none of them share state. The handful of POSTs that workerd
  // has historically flaked on are covered by fetchExpectingNon5xx's one-shot
  // retry, so concurrent fan-out is safe.
  const subscribeResults = await Promise.all(
    subscribeCases.map((c) => fetchExpectingNon5xx(`${BASE}/api/subscribe`, c.init)),
  );
  subscribeResults.forEach((res, i) => {
    const c = subscribeCases[i];
    check(`subscribe: ${c.name}`, res.status === c.expect, `got ${res.status}`);
  });

  // Realistic-sized payload doesn't 413. Real Turnstile tokens are 2-4 KB;
  // the parseJson maxBytes cap must accommodate. Send a 2.5 KB token payload
  // (won't pass Turnstile verify, but that's fine — we're asserting the body
  // cap, not the verify path). Should return one of the 4xx Turnstile codes,
  // NEVER 413. Kept out of the table above because the assertion is an
  // inequality with a longer diagnostic message.
  const [bigTokenPayload, privacy] = await Promise.all([
    fetchExpectingNon5xx(`${BASE}/api/subscribe`, jsonPost({
      email: 'sized@example.com',
      turnstileToken: 'x'.repeat(2500),
      company: '',
    })),
    fetchRoute('/privacy'),
  ]);
  check(
    'subscribe: realistic 2.5KB payload is not rejected as too large (regression guard for the 1KB cap)',
    bigTokenPayload.status !== 413,
    `got ${bigTokenPayload.status} (413 means the body cap is too tight — real Turnstile tokens are 2-4 KB)`,
  );

  // /privacy must exist and name the third parties so the form fineprint
  // links to a real disclosure.
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
