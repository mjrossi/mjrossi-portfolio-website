// Everything checkable without a running worker, in two phases.
//
// `checkSourceGuards` greps source files for invariants the live matrices
// cannot see — a call site that stopped consulting a predicate, an identifier
// that must never appear in a listing helper. Treat these as diagnostics rather
// than coverage: the live matrix in live-preview.mjs strictly dominates them on
// the surfaces they check, but it fails 90 seconds later without naming a file.
//
// `checkBuildArtifacts` reads dist/client — assets, the generated _headers, and
// the CSS bundle.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { check, stripComments } from './check.mjs';
import { DIST, GALLEY_WRITE_QUOTA } from './config.mjs';

/** Read and comment-strip a source file, or return '' if it isn't there. */
function source(path) {
  return existsSync(path) ? stripComments(readFileSync(path, 'utf8')) : '';
}

export function distExists() {
  return existsSync(DIST);
}

export function checkSourceGuards() {
  // Guard against accidental removal of fetchWithRetry from src/lib/server.ts.
  // /api/subscribe relies on it for transient-503 resilience on the Turnstile
  // siteverify and Buttondown create-subscriber calls.
  const serverLibPath = resolve('src/lib/server.ts');
  if (existsSync(serverLibPath)) {
    check(
      'src/lib/server.ts: fetchWithRetry is exported',
      /export\s+async\s+function\s+fetchWithRetry\b/.test(readFileSync(serverLibPath, 'utf8')),
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
  //
  // Comments stripped throughout this block so a file's own explanation of why
  // an identifier is deliberately absent can't satisfy — or trip — the check
  // asserting its presence or absence. The identifier has to be in real code.
  const postRoute = source(resolve('src/pages/blog/[...slug].astro'));
  if (postRoute) {
    check(
      'blog post route: honours previewSlug',
      /previewSlug/.test(postRoute),
      'scoped preview unlock missing from [...slug].astro — signed preview links would 404',
    );
  }

  // The preview unlock must never widen beyond the post's own URL. If
  // previewSlug ever reaches the listing helpers, a shared preview link could
  // inject an unpublished post into the RSS feed — which is what triggers
  // Buttondown's email to real subscribers. previewReviewer is subject to the
  // same rule for the same reason: a link that lets an editor leave notes is
  // still scoped to one post.
  const blogLibSource = source(blogLibPath);
  const rssRoutePath = resolve('src/pages/blog/rss.xml.ts');
  const rssSource = source(rssRoutePath);
  check(
    'src/lib/blog.ts: previewSlug does NOT reach the listing helpers',
    !/previewSlug/.test(blogLibSource),
    'previewSlug leaked into blog.ts — a signed preview link could reach the index/tags/RSS',
  );
  if (existsSync(rssRoutePath)) {
    check(
      'rss route: previewSlug does NOT reach the feed',
      !/previewSlug/.test(rssSource),
      'previewSlug leaked into the RSS route — a preview link could trigger the subscriber email',
    );
  }
  check(
    'src/lib/blog.ts: previewReviewer does NOT reach the listing helpers',
    !/previewReviewer/.test(blogLibSource),
    'previewReviewer leaked into blog.ts — a review link could reach the index/tags/RSS',
  );
  if (existsSync(rssRoutePath)) {
    check(
      'rss route: previewReviewer does NOT reach the feed',
      !/previewReviewer/.test(rssSource),
      'previewReviewer leaked into the RSS route — a review link could trigger the subscriber email',
    );
  }

  // The galley's client JS is the site's SECOND carve-out from the no-client-JS
  // rule, and the narrower of the two: it may only ship on a response that
  // middleware has already forced to no-store + noindex. That holds because
  // BlogPost.astro gates it on previewReviewer AND a previewSlug matching the
  // post being rendered. Dropping either half would put review chrome — and a
  // script tag — on publicly cacheable pages. The live matrix proves the
  // behaviour; this names the file and the invariant when it breaks.
  const layoutSource = source(resolve('src/layouts/BlogPost.astro'));
  if (layoutSource) {
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
  // proves the behaviour; this names the file when someone "simplifies" the
  // insert back into a SELECT followed by an INSERT.
  const endpointSource = source(resolve('src/pages/api/galley.ts'));
  if (endpointSource) {
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
}

export function checkBuildArtifacts() {
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
      '_headers: CSP allows challenges.cloudflare.com',
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
  // `/scripts/galley.js` assertions in the live matrix. `is:inline` keeps it out.
  check(
    'css: galley styles are not in the public bundle',
    !/galley-/.test(css),
    'galley CSS was hoisted into a route stylesheet — is:inline dropped from GalleyMargin.astro?',
  );
}
