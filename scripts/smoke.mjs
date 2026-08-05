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
import { d1Exec, d1Migrate } from './d1.mjs';
import { clearLinks, recordLinks } from './links-db.mjs';

const DIST = resolve('dist/client');
const PORT = Number(process.env.SMOKE_PORT ?? 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const READY_TIMEOUT_MS = 30_000;

// The permanently-future-dated post in src/content/blog/. Everything in the
// scheduled-post matrix below keys off it.
const FIXTURE_SLUG = 'smoke-scheduled-fixture';
const FIXTURE_TAG = 'smoke-fixture';
// A slug that names no real post, used by the cross-slug assertions: a token
// minted for another draft must not open or write to the fixture.
const OTHER_SLUG = 'some-other-draft';

// D1 database holding galley notes. Must match wrangler.jsonc's database_name.
const GALLEY_DB = 'mjrossi-galley';
// Reviewer label used for the galley assertions. Scoped to smoke so a real
// review file can never be confused with test rows.
const SMOKE_REVIEWER = 'smoke-reviewer';
// Mirrors MAX_NOTES_PER_REVIEWER in src/pages/api/galley.ts. Asserted against
// the source below rather than imported — the endpoint is TypeScript and this
// file runs under bare node.
const GALLEY_WRITE_QUOTA = 60;

// Allowlist rows for the preview and galley matrices. Every token carries a
// link id, and middleware refuses a grant whose row is missing or revoked, so
// each token signed below needs a row seeded before wrangler dev starts.
//
// Fixed rather than random so the seeded rows and the tokens signed later
// cannot drift apart. One per token, because each assertion is named for the
// thing it isolates — expiry, slug scoping, reviewer scoping — and sharing a
// row between two of them would let one test's revocation break another's
// stated reason for failing.
const VIEW_LINK_ID = 'aaaa0000bbbb1111'; // the view-only fixture link
const WRONG_SLUG_ID = 'bbbb1111cccc2222'; // view-only, minted for another post
const EXPIRED_LINK_ID = 'cccc2222dddd3333'; // live row, deliberately expired token
const LIVE_LINK_ID = 'dddd3333eeee4444'; // the working review link
const CROSS_SLUG_ID = 'eeee4444ffff5555'; // review link for another post
const REVOKED_LINK_ID = 'ffff5555aaaa6666'; // seeded already revoked
const UNKNOWN_LINK_ID = '99998888aaaabbbb'; // deliberately never inserted

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

// previewReviewer is subject to the same rule, for the same reason: a link
// that lets an editor leave notes is still scoped to one post, and must not
// widen the listing helpers or the feed any more than a read-only one does.
check(
  'src/lib/blog.ts: previewReviewer does NOT reach the listing helpers',
  !/previewReviewer/.test(blogLibSource),
  'previewReviewer leaked into blog.ts — a review link could reach the index/tags/RSS',
);
if (existsSync(rssRoutePath)) {
  check(
    'rss route: previewReviewer does NOT reach the feed',
    !/previewReviewer/.test(stripComments(readFileSync(rssRoutePath, 'utf8'))),
    'previewReviewer leaked into the RSS route — a review link could trigger the subscriber email',
  );
}

// The galley's client JS is the site's SECOND carve-out from the no-client-JS
// rule, and the narrower of the two: it may only ship on a response that
// middleware has already forced to no-store + noindex. That holds because
// BlogPost.astro gates it on previewReviewer AND a previewSlug matching the
// post being rendered. Dropping either half would put review chrome — and a
// script tag — on publicly cacheable pages. The live matrix below proves the
// behaviour; this names the file and the invariant when it breaks.
const blogPostLayout = resolve('src/layouts/BlogPost.astro');
if (existsSync(blogPostLayout)) {
  const layoutSource = stripComments(readFileSync(blogPostLayout, 'utf8'));
  check(
    'BlogPost.astro: galley is gated on previewReviewer',
    /previewReviewer/.test(layoutSource),
    'BlogPost.astro no longer reads previewReviewer — the galley gate is gone',
  );
  check(
    'BlogPost.astro: galley gate also matches the post slug',
    /previewSlug\s*===\s*post\.id/.test(layoutSource),
    'the galley gate no longer compares previewSlug to the rendered post',
  );
}

// The write quota must stay ONE statement. A check-then-insert pair passes
// every sequential test and still lets concurrent requests race past the limit,
// and the quota is the stated bound on a leaked review link. The live flood
// below proves the behaviour; this names the file when someone "simplifies" the
// insert back into a SELECT followed by an INSERT.
const galleyEndpoint = resolve('src/pages/api/galley.ts');
if (existsSync(galleyEndpoint)) {
  const endpointSource = stripComments(readFileSync(galleyEndpoint, 'utf8'));
  check(
    'api/galley.ts: the quota and the insert are one statement',
    /INSERT INTO galley_notes[\s\S]*?SELECT[\s\S]*?WHERE\s*\(SELECT COUNT\(\*\)/.test(endpointSource),
    'the write quota is no longer a conditional INSERT — concurrent writes can race past it',
  );
  check(
    `api/galley.ts: the write quota is still ${GALLEY_WRITE_QUOTA}`,
    new RegExp(`MAX_NOTES_PER_REVIEWER\\s*=\\s*${GALLEY_WRITE_QUOTA}\\b`).test(endpointSource),
    `the endpoint's quota no longer matches GALLEY_WRITE_QUOTA in this file — the flood assertion below would go green against the wrong bound`,
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
//
// The walk is structural rather than a list of known binding categories, and
// that is the whole point: the case this check exists for is an adapter release
// injecting something *new*, which by definition lands in a category nobody
// thought to enumerate. Today's generated config already carries a dozen keys a
// hand-written list would have missed (`pipelines`, `secrets_store_secrets`,
// `ai_search`, `agent_memory`, `artifacts`, `worker_loaders`, `vpc_services`,
// `logfwdr.bindings`, `previews.kv_namespaces`, plus the object-shaped
// `browser` / `images` / `version_metadata` that aren't emitted while unused).
// Wrangler keys almost all of them off a `binding` property, so walking for that
// property catches an invented `some_future_thing_2027` too.
const NAME_KEYED_BINDINGS = [
  'durable_objects.bindings',
  'send_email',
  'logfwdr.bindings',
  'unsafe.bindings',
  'ratelimits',
];

function atPath(config, path) {
  return path.split('.').reduce((node, key) => node?.[key], config);
}

function bindingNames(config) {
  const names = new Set();
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (typeof node.binding === 'string') names.add(node.binding);
    for (const value of Object.values(node)) walk(value);
  };
  walk(config);
  // The exceptions: five collections key the binding as `name` rather than
  // `binding`, so the structural walk cannot see them. Unlike a category
  // allowlist, an omission here is not a hole in the whole check, only in the
  // collection omitted — but it is still a hole, so the assertion below
  // re-derives the same set from wrangler's shipped JSON schema and fails if
  // they diverge.
  //
  // `workflows` and `containers` carry a `name` too and are deliberately absent:
  // workflows also carry a `binding` (the walk has them already, and adding the
  // workflow's own name would be a false positive), and a container's `name` is
  // an app identifier rather than an env binding — its Worker-visible binding is
  // the Durable Object one, which is covered.
  for (const path of NAME_KEYED_BINDINGS) {
    for (const entry of atPath(config, path) ?? []) {
      if (typeof entry?.name === 'string') names.add(entry.name);
    }
  }
  return names;
}

// Re-derive NAME_KEYED_BINDINGS from wrangler's own config schema, so the list
// above cannot quietly rot. A collection it misses is missed *silently* —
// `ratelimits` sat in exactly that state until a review caught it — and nobody
// re-derives a comment that claims to be exhaustive. A wrangler upgrade that
// adds a name-keyed collection now goes red here instead. Skipped (not failed)
// if the schema file ever stops shipping: that is a packaging change, not drift.
const wranglerSchemaPath = resolve('node_modules/wrangler/config-schema.json');
if (existsSync(wranglerSchemaPath)) {
  try {
    const schema = JSON.parse(readFileSync(wranglerSchemaPath, 'utf8'));
    const found = new Set();
    const scan = (props, prefix) => {
      for (const [key, value] of Object.entries(props ?? {})) {
        const item = value.items ?? value.anyOf?.map((a) => a.items).find(Boolean);
        const fields = item?.properties;
        if (fields) {
          if ('name' in fields && !('binding' in fields)) found.add(`${prefix}${key}`);
        } else if (value.properties && prefix === '') {
          scan(value.properties, `${key}.`);
        }
      }
    };
    scan(schema.definitions?.RawConfig?.properties ?? schema.properties, '');
    // Name-keyed but an app definition rather than an env binding — see above.
    found.delete('containers');
    const missing = [...found].filter((key) => !NAME_KEYED_BINDINGS.includes(key));
    check(
      'NAME_KEYED_BINDINGS still matches wrangler config schema',
      missing.length === 0,
      `${missing.join(', ')} key their binding off \`name\` in wrangler's schema but are not in` +
        ' NAME_KEYED_BINDINGS — bindings in those collections are invisible to the drift check',
    );
  } catch (err) {
    check('wrangler config schema parses', false, String(err));
  }
}

// Locate the generated config the way wrangler itself does, then assert it
// exists *before* reading it. Silently skipping the comparison on a missing
// file would fail open on precisely the scenario this check guards — a future
// adapter release that relocates its output would take the whole block out of
// the suite with nothing going red.
//
// .wrangler/deploy/config.json is wrangler's redirected-configuration pointer:
// the adapter writes it, and `wrangler dev`/`deploy` follow it rather than the
// root wrangler.jsonc. Reading the path from there instead of hardcoding it
// means a relocation is *followed*, not merely reported. The literal path stays
// as a fallback for the case where the redirect itself is what disappeared.
function resolveGeneratedConfig() {
  const redirect = resolve('.wrangler/deploy/config.json');
  if (existsSync(redirect)) {
    try {
      const { configPath } = JSON.parse(readFileSync(redirect, 'utf8'));
      if (configPath) return resolve('.wrangler/deploy', configPath);
    } catch {
      // Fall through to the default path; the existence check below reports it.
    }
  }
  return resolve('dist/server/wrangler.json');
}

const generatedConfig = resolveGeneratedConfig();
check(
  'generated wrangler config exists',
  existsSync(generatedConfig),
  `no generated config at ${generatedConfig} — either the build did not run, or the adapter moved` +
    ' it and the binding-drift check below is no longer running at all',
);
// Asserted rather than merely guarded, for the same fail-open reason as the
// generated config above: a bare existsSync here would delete the comparison
// silently.
check(
  'wrangler.jsonc exists',
  existsSync(wranglerConfig),
  `no wrangler.jsonc at ${wranglerConfig} — the binding-drift check has nothing to compare against`,
);
if (existsSync(wranglerConfig) && existsSync(generatedConfig)) {
  let declared;
  let generated;
  try {
    // stripComments only removes lines that START with `//`, so URLs inside
    // string values survive — but a trailing `// comment` after a value would
    // not be stripped and would break the parse. Keep comments on their own
    // lines in wrangler.jsonc. Trailing commas are legal in JSONC but not JSON,
    // so drop them too rather than failing on a legal config.
    const asJson = stripComments(readFileSync(wranglerConfig, 'utf8')).replace(/,(\s*[}\]])/g, '$1');
    declared = bindingNames(JSON.parse(asJson));
    generated = bindingNames(JSON.parse(readFileSync(generatedConfig, 'utf8')));
  } catch (err) {
    declared = null;
    check('wrangler configs parse as JSON', false, String(err));
  }
  if (declared) {
    // Without this the comparison passes vacuously whenever the walk stops
    // finding anything — a wrangler release renaming the `binding` property, or
    // an adapter emitting a differently-shaped document, would leave every
    // future binding undetected with the suite still green. ASSETS is
    // structurally guaranteed for a Worker with static assets, so its absence
    // means the walk broke rather than that a binding went away.
    check(
      'binding walk still finds bindings in the generated config',
      generated.has('ASSETS'),
      `generated config yielded [${[...generated].join(', ') || 'nothing'}] — ASSETS missing means` +
        ' the walk no longer understands the config shape, and the drift check below proves nothing',
    );
    const undeclared = [...generated].filter((name) => !declared.has(name));
    check(
      'wrangler.jsonc declares every binding in the built worker',
      undeclared.length === 0,
      `${undeclared.join(', ')} present in the generated config but not declared in wrangler.jsonc` +
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

// The galley's styles must not reach the public CSS bundle. A processed
// <style> in GalleyMargin.astro is hoisted into the /blog/[...slug] stylesheet
// by the static module graph, NOT by the runtime condition that renders the
// component — so a plain <style> there ships ~4.9KB of review chrome as a
// render-blocking stylesheet on every published post. That is the one way this
// component can reach a publicly cacheable page, and it is invisible in the
// HTML, which is why it needs a check of its own rather than relying on the
// `/scripts/galley.js` assertions below. `is:inline` is what keeps it out.
check(
  'css: galley styles are not in the public bundle',
  !/galley-/.test(css),
  'galley CSS was hoisted into a route stylesheet — is:inline dropped from GalleyMargin.astro?',
);

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

// ── local D1 fixtures ──────────────────────────────
//
// All of this runs BEFORE wrangler dev is spawned, and it has to. wrangler dev
// reads the persisted SQLite once at startup and does not flush its own writes
// back, so a row inserted here mid-run would not be seen by the running worker —
// which is also why the revoked case below is seeded as an already-revoked row
// rather than by revoking partway through. That tests enforcement, which is the
// part that matters, without a second process writing the database underneath
// the first.
//
// Local only throughout; none of this can touch the production database.

// wrangler dev does NOT apply migrations on startup — it just hands the worker
// an empty database. Without this the galley and allowlist assertions would
// fail with "no such table", which reads like a broken endpoint rather than an
// unmigrated fixture.
try {
  d1Migrate({ local: true });
} catch (err) {
  console.error(`smoke: could not migrate the local ${GALLEY_DB} database\n${err.message}`);
  process.exit(1);
}

// Clear this suite's own rows, because the rate-limit assertion below
// deliberately fills the hourly write quota. If those rows ever survived to the
// next run, the FIRST write of that run would come back 429 and the positive
// path would fail — a confusing failure whose cause is an hour old.
//
// Today they don't: the local database file keeps the schema between runs (it
// is what the migration above writes to) but rows written through `wrangler dev`
// are not flushed to it when smoke kills the process, so each run starts empty
// in practice. That is observed wrangler behaviour, not a contract, and it is
// the kind of thing a version bump changes quietly — so the suite does not
// depend on it. Scoped to SMOKE_REVIEWER and to the two fixture slugs, so it can
// only ever touch rows this file wrote.
try {
  d1Exec(`DELETE FROM galley_notes WHERE reviewer = '${SMOKE_REVIEWER}'`, { local: true });
  clearLinks([FIXTURE_SLUG, OTHER_SLUG], { local: true });
} catch (err) {
  console.error(`smoke: could not clear previous ${GALLEY_DB} rows\n${err.message}`);
  process.exit(1);
}

// Every token signed below needs a row, because middleware refuses a grant
// whose link is not in the allowlist. One row per token rather than a shared
// one: each assertion is named for the thing it isolates — expiry, slug
// scoping, reviewer scoping — and a token that 404s for want of a row would
// pass its check while testing nothing.
//
// Seeded through recordLinks, the same function production mints through, so a
// schema change that breaks minting breaks this fixture in the same commit
// rather than leaving a green suite pointed at a table nothing writes any more.
const FAR_FUTURE_EXP = 4102444800; // 2100-01-01; the token's own exp is what expires
try {
  recordLinks(
    [
      { id: VIEW_LINK_ID, slug: FIXTURE_SLUG, reviewer: null, exp: FAR_FUTURE_EXP },
      { id: WRONG_SLUG_ID, slug: OTHER_SLUG, reviewer: null, exp: FAR_FUTURE_EXP },
      // Live row, expired token — so `preview: expired token 404s` still fails
      // for the reason it is named after.
      { id: EXPIRED_LINK_ID, slug: FIXTURE_SLUG, reviewer: null, exp: FAR_FUTURE_EXP },
      { id: LIVE_LINK_ID, slug: FIXTURE_SLUG, reviewer: SMOKE_REVIEWER, exp: FAR_FUTURE_EXP },
      { id: CROSS_SLUG_ID, slug: OTHER_SLUG, reviewer: SMOKE_REVIEWER, exp: FAR_FUTURE_EXP },
      // The allowlist's own negative case. UNKNOWN_LINK_ID is deliberately
      // absent — a well-signed token for a row that was never written.
      {
        id: REVOKED_LINK_ID,
        slug: FIXTURE_SLUG,
        reviewer: SMOKE_REVIEWER,
        exp: FAR_FUTURE_EXP,
        revokedAt: Date.now(),
      },
    ],
    { local: true },
  );
} catch (err) {
  console.error(`smoke: could not seed ${GALLEY_DB} preview_links fixtures\n${err.message}`);
  process.exit(1);
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
  const fixtureToken = await signPreviewToken(
    { slug: FIXTURE_SLUG, exp: fixtureExp, linkId: VIEW_LINK_ID }, PREVIEW_KEY);
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
  const wrongSlugToken = await signPreviewToken(
    { slug: OTHER_SLUG, exp: fixtureExp, linkId: WRONG_SLUG_ID }, PREVIEW_KEY);
  const wrongSlug = await fetch(`${BASE}/blog/${FIXTURE_SLUG}/?preview=${encodeURIComponent(wrongSlugToken)}`);
  check(
    'preview: a token minted for another slug does not open the fixture',
    wrongSlug.status === 404,
    `got ${wrongSlug.status} — a signed token unlocked a post it was not minted for`,
  );

  // An expired token must 404 the post exactly like no token at all.
  const expiredToken = await signPreviewToken(
    { slug: FIXTURE_SLUG, exp: Math.floor(Date.now() / 1000) - 60, linkId: EXPIRED_LINK_ID },
    PREVIEW_KEY);
  const expired = await fetch(`${BASE}/blog/${FIXTURE_SLUG}/?preview=${encodeURIComponent(expiredToken)}`);
  check('preview: expired token 404s the scheduled post', expired.status === 404, `got ${expired.status}`);

  // ── Galley matrix ──────────────────────────────────
  // Everything above tests a READ-ONLY preview link. A galley link grants
  // strictly more — the right to write — so it gets its own matrix. The point
  // of most of these is that granting more never widens the SCOPE: a review
  // link is still one post, still not the index, and above all still not the
  // feed that triggers Buttondown's send.
  const galleyToken = await signPreviewToken(
    { slug: FIXTURE_SLUG, exp: fixtureExp, reviewer: SMOKE_REVIEWER, linkId: LIVE_LINK_ID },
    PREVIEW_KEY);
  const gq = `preview=${encodeURIComponent(galleyToken)}`;
  const galleyApi = `${BASE}/api/galley?${gq}`;

  // 1. The chrome ships only where it is allowed to.
  const galleyPost = await fetch(`${BASE}/blog/${FIXTURE_SLUG}/?${gq}`);
  const galleyHtml = await galleyPost.text();
  check('galley: review link opens the post', galleyPost.status === 200, `got ${galleyPost.status}`);
  check('galley: review link loads /scripts/galley.js', galleyHtml.includes('/scripts/galley.js'));
  check(
    'galley: reviewed page is never cached',
    (galleyPost.headers.get('cache-control') ?? '').includes('no-store'),
    `cache-control was ${galleyPost.headers.get('cache-control')}`,
  );
  check(
    'galley: reviewed page is noindex',
    (galleyPost.headers.get('x-robots-tag') ?? '').includes('noindex'),
  );

  // A READ-ONLY token must not ship the review chrome. This is the difference
  // between the two token shapes, over HTTP.
  const viewOnlyHtml = await fetch(`${BASE}/blog/${FIXTURE_SLUG}/?${q}`).then((r) => r.text());
  check(
    'galley: a view-only preview link does NOT load galley.js',
    !viewOnlyHtml.includes('/scripts/galley.js'),
    'the galley shipped for a link that never granted review rights',
  );

  // The second carve-out must stay off every public page. /blog is the one
  // that already carries client JS, which is exactly why it is worth pinning.
  const [homeGalley, blogGalley] = await Promise.all([
    fetch(`${BASE}/`).then((r) => r.text()),
    fetch(`${BASE}/blog`).then((r) => r.text()),
  ]);
  check('galley: absent from the home page', !homeGalley.includes('/scripts/galley.js'));
  check('galley: absent from /blog', !blogGalley.includes('/scripts/galley.js'));
  // A PUBLISHED post is the page the carve-out is really about: it renders the
  // same route and the same layout as a review session, differing only by the
  // gate in BlogPost.astro. Assert on `galley-` rather than the script src so
  // this also catches styles or markup leaking without the client JS — the
  // exact shape the inline-style fix in GalleyMargin.astro exists to prevent.
  if (post) {
    check(
      'galley: absent from a published post',
      !post.html.includes('galley-'),
      'galley chrome reached a page any reader can load — and one that IS edge-cached',
    );
  }

  // 2. Writing requires a reviewer token, not merely a valid one.
  const noteBody = { slug: FIXTURE_SLUG, kind: 'comment', src: '8-8', quote: 'test fixture', body: 'smoke note' };
  const postNote = (token, body = noteBody) =>
    fetch(`${BASE}/api/galley${token ? `?preview=${encodeURIComponent(token)}` : ''}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

  const wrote = await postNote(galleyToken);
  check('galley: a reviewer token can leave a note', wrote.status === 200, `got ${wrote.status}`);

  const viewOnlyWrite = await postNote(fixtureToken);
  check(
    'galley: a view-only token CANNOT leave a note',
    viewOnlyWrite.status === 403,
    `got ${viewOnlyWrite.status} — reading a draft must not imply writing to it`,
  );

  const anonWrite = await postNote(null);
  check('galley: an untokened POST is refused', anonWrite.status === 403, `got ${anonWrite.status}`);

  // A perfectly valid signature for a DIFFERENT post must not file a note
  // against this one — the case a signature check alone cannot catch.
  const otherGalleyToken = await signPreviewToken(
    { slug: OTHER_SLUG, exp: fixtureExp, reviewer: SMOKE_REVIEWER, linkId: CROSS_SLUG_ID },
    PREVIEW_KEY);
  const crossWrite = await postNote(otherGalleyToken);
  check(
    'galley: a token for another slug cannot write to the fixture',
    crossWrite.status === 403,
    `got ${crossWrite.status} — a valid token wrote to a post it was not minted for`,
  );

  // 3. Read-back works, and is scoped the same way.
  const listed = await fetch(galleyApi);
  const listedJson = await listed.json().catch(() => ({}));
  check('galley: notes read back for the granted post', listed.status === 200, `got ${listed.status}`);
  check(
    'galley: the note just written is in the list',
    Array.isArray(listedJson.notes) && listedJson.notes.some((n) => n.body === 'smoke note'),
  );
  check(
    'galley: the note is attributed to the token’s reviewer',
    Array.isArray(listedJson.notes) && listedJson.notes.every((n) => n.reviewer === SMOKE_REVIEWER),
    'a note was attributed to someone other than the signed reviewer',
  );
  const viewOnlyRead = await fetch(`${BASE}/api/galley?${q}`);
  check('galley: a view-only token cannot read notes', viewOnlyRead.status === 403, `got ${viewOnlyRead.status}`);

  // 4. THE ONE THAT MATTERS MOST. A review link grants writing; it must still
  // not put the draft anywhere a reader — or Buttondown's poller — can find it.
  const [galleyIndex, galleyRss] = await Promise.all([
    fetch(`${BASE}/blog?${gq}`).then((r) => r.text()),
    fetch(`${BASE}/blog/rss.xml?${gq}`).then((r) => r.text()),
  ]);
  check(
    'galley: a review link does NOT add the post to /blog',
    !galleyIndex.includes(FIXTURE_SLUG),
    'a galley link reached the blog index',
  );
  check(
    'galley: a review link does NOT add the post to RSS',
    !galleyRss.includes(FIXTURE_SLUG),
    'a galley link reached the feed — this would trigger the subscriber email',
  );

  // 5. Validation is actually wired to the endpoint. src/lib/galley.test.js
  // covers the rules themselves; this only proves they are being consulted.
  const emptyNote = await postNote(galleyToken, { slug: FIXTURE_SLUG, kind: 'comment', body: '  ' });
  check('galley: an empty note is rejected', emptyNote.status === 400, `got ${emptyNote.status}`);
  const hugeNote = await postNote(galleyToken, { slug: FIXTURE_SLUG, kind: 'comment', body: 'x'.repeat(5000) });
  check('galley: an oversize note is rejected', hugeNote.status === 400, `got ${hugeNote.status}`);

  // The second note kind. `suggestion` has always been in the schema, the
  // validator and the pull script, but nothing could create one until the
  // composer grew an optional replacement field — so this is the first thing
  // that proves the kind works end to end rather than only in unit tests.
  const suggested = await postNote(galleyToken, {
    slug: FIXTURE_SLUG, kind: 'suggestion', src: '8-8',
    quote: 'test fixture', suggestion: 'a proposed rewrite',
  });
  check('galley: a suggestion note is accepted', suggested.status === 200, `got ${suggested.status}`);
  const afterSuggestion = await fetch(galleyApi).then((r) => r.json()).catch(() => ({}));
  check(
    'galley: the suggestion reads back with its replacement text',
    Array.isArray(afterSuggestion.notes) &&
      afterSuggestion.notes.some((n) => n.kind === 'suggestion' && n.suggestion === 'a proposed rewrite'),
    'a suggestion round-tripped without the text that is its whole content',
  );
  // The column is write-once and every row reads 'open', so the endpoint stops
  // shipping it. Pinned because re-adding it is a one-word change that would
  // put a meaningless constant back in front of a client author.
  check(
    'galley: notes do not carry the unused status column',
    Array.isArray(afterSuggestion.notes) && afterSuggestion.notes.every((n) => !('status' in n)),
  );

  // 6. THE ALLOWLIST.
  // A valid signature is necessary but no longer sufficient: a token grants
  // nothing unless its row in preview_links is present and un-revoked. This is
  // the direction the positive paths above cannot show — they prove a good link
  // still works, not that a withdrawn one stops.
  //
  // Revocation deliberately takes READING as well as writing, so each case
  // asserts both: a link that still opened the draft after being revoked would
  // defeat the point of revoking it. Reading notes goes through the same
  // previewReviewer the write does, so a third GET per case would add nothing.
  const revokedToken = await signPreviewToken(
    { slug: FIXTURE_SLUG, exp: fixtureExp, reviewer: SMOKE_REVIEWER, linkId: REVOKED_LINK_ID },
    PREVIEW_KEY);
  const unknownToken = await signPreviewToken(
    { slug: FIXTURE_SLUG, exp: fixtureExp, reviewer: SMOKE_REVIEWER, linkId: UNKNOWN_LINK_ID },
    PREVIEW_KEY);

  for (const [label, token] of [['revoked', revokedToken], ['unrecorded', unknownToken]]) {
    const page = await fetch(`${BASE}/blog/${FIXTURE_SLUG}/?preview=${encodeURIComponent(token)}`);
    check(
      `galley: a ${label} link cannot open the post`,
      page.status === 404,
      `got ${page.status} — a signature alone opened a draft the allowlist does not vouch for`,
    );
    const write = await postNote(token, {
      slug: FIXTURE_SLUG, kind: 'comment', quote: 'test fixture', body: `${label} write`,
    });
    check(
      `galley: a ${label} link cannot leave a note`,
      write.status === 403,
      `got ${write.status}`,
    );
  }

  // 7. The write quota bounds a leaked review link between the moment it goes
  // astray and the moment anyone notices to revoke it. Revocation is the real
  // remedy (section 6), but it needs a human to know the link leaked; until
  // then this is what stops one from filling the table. Worth proving it
  // actually fires rather than trusting the constant.
  //
  // Fired in PARALLEL, deliberately. A sequential flood passes against a
  // check-then-insert quota, which is exactly the implementation that does not
  // hold: two round-trips let N concurrent requests all read the same pre-flood
  // count, all pass, and all insert. Someone with a leaked link has no reason
  // to be polite about it, so the test shouldn't be either. The endpoint does
  // the count and the insert in one statement, which is what makes this pass.
  //
  // Runs last in this section, since it fills the hour's allowance. The
  // post-migration DELETE keeps it idempotent across runs.
  const flood = await Promise.all(
    Array.from({ length: 90 }, (_, i) =>
      postNote(galleyToken, {
        slug: FIXTURE_SLUG, kind: 'comment', quote: 'test fixture', body: `flood ${i}`,
      }).then((res) => res.status)),
  );
  const accepted = flood.filter((s) => s === 200).length;
  const refused = flood.filter((s) => s === 429).length;
  check(
    'galley: the write quota stops a flooded review link',
    refused > 0,
    `90 concurrent notes, none refused — statuses seen: ${[...new Set(flood)].join(', ')}`,
  );
  // The bound has to hold under concurrency, not merely exist. Anything over
  // the cap means the count was observed and then invalidated before the row
  // landed — the race a sequential loop cannot see.
  check(
    'galley: the quota holds under concurrent writes',
    accepted <= GALLEY_WRITE_QUOTA,
    `${accepted} of 90 concurrent notes were accepted, quota is ${GALLEY_WRITE_QUOTA}` +
      ' — check-then-insert raced past the limit',
  );

  // 8. The anchoring contract, end to end. A data-src in served HTML must name
  // the line of the .mdx that actually holds that text. Unit tests cannot see
  // this: they build mdast by hand and so cannot catch remark's line numbers
  // shifting relative to the file (frontmatter being stripped, say), which
  // would move every anchor by a constant and silently misdirect every note.
  const anchorMatch = /<p data-src="(\d+)-\d+"[^>]*>([^<]{25,80})/.exec(galleyHtml);
  check('galley: served HTML carries source anchors', anchorMatch !== null);
  if (anchorMatch) {
    const fixtureLines = readFileSync(
      resolve('src/content/blog', `${FIXTURE_SLUG}.mdx`),
      'utf8',
    ).split('\n');
    // Fold the typography smartypants introduces (’ for ', em dashes) before
    // comparing — see scripts/galley-pull.mjs, which folds the same way.
    const fold = (s) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
    const sourceLine = fold(fixtureLines[Number(anchorMatch[1]) - 1] ?? '');
    const rendered = fold(anchorMatch[2]).slice(0, 25);
    check(
      'galley: an anchor points at the .mdx line holding its text',
      sourceLine.includes(rendered),
      `data-src said line ${anchorMatch[1]}, which reads ${JSON.stringify(sourceLine.slice(0, 60))} ` +
        `but the rendered text there starts ${JSON.stringify(rendered)}`,
    );
  }

  // Leave the local database as we found it, so a rerun asserts against a
  // clean table rather than accumulating rows from every previous run. Links
  // included — they are seeded before the spawn, so unlike the notes they DO
  // survive to the next run and would collide with the seeding INSERT.
  try {
    d1Exec(`DELETE FROM galley_notes WHERE reviewer = '${SMOKE_REVIEWER}'`, { local: true });
    clearLinks([FIXTURE_SLUG, OTHER_SLUG], { local: true });
  } catch {
    // Cleanup is best-effort; a stale smoke row never affects production.
  }

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
  // Static checks all run before wrangler is spawned, so anything they already
  // found is the more useful diagnostic — and is often the cause. A missing
  // generated config, for instance, also stops `wrangler dev` from resolving
  // its redirected configuration, which surfaces here as a bare readiness
  // timeout unless the recorded failure is printed alongside it.
  if (fails.length) {
    console.error(`smoke: ${fails.length} check(s) had already failed before this:`);
    for (const f of fails) {
      console.error(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
    }
  }
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
