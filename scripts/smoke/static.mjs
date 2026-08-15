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
import { join, relative, resolve } from 'node:path';
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

  // THE DESTRUCTIVE FIXTURE HELPERS MUST STAY OUT OF THE WORKER.
  //
  // clearLinks, clearNotes and seedNotes delete and forge rows. Their only
  // guard is `if (!local) throw` in scripts/links-db.mjs and
  // scripts/notes-db.mjs — a CLI-side guard, because `--local` is a fact about
  // which database a script was pointed at and the store modules deliberately
  // do not know what a database is.
  //
  // That guard was inherited for free while the SQL lived in scripts/, outside
  // the worker's module graph: the worker had no path to these functions and
  // could not have called them unguarded. Moving the statements into
  // src/lib/*-store.js so one copy runs on both paths ended that — they are now
  // one named import away from any route, and the comments in those modules
  // still make the old structural claim. This restores it as something checked
  // rather than something asserted, in the same shape as the previewSlug greps
  // above. The Desk imports reads only, so this passes today.
  const destructive = /\b(clearLinks|clearNotes|seedNotes)\b/;
  const workerFiles = [...walk(resolve('src/pages')), resolve('src/middleware.ts')];
  const offenders = workerFiles.filter((path) => destructive.test(source(path)));
  // One check, not one per file, and it names the offenders in its own failure
  // message — a per-file loop would emit assertions only when they FAIL, so a
  // run where `walk` found nothing at all would print no checks and look
  // identical to a clean one.
  check(
    `worker: no route imports a destructive fixture helper (${workerFiles.length} files scanned)`,
    workerFiles.length > 0 && offenders.length === 0,
    workerFiles.length === 0
      ? 'no worker source files were scanned — this guard was vacuous'
      : `clearLinks/clearNotes/seedNotes reached the worker in ${offenders
          .map((p) => relative(resolve('.'), p))
          .join(', ')}, where the --local guard in scripts/links-db.mjs and ` +
        'scripts/notes-db.mjs cannot apply — these delete and forge rows',
  );
}

/** Every file under `dir`, recursively. Returns [] if it isn't there. */
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
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

  // THE SITEMAP MUST NOT NAME THE DESK. /admin is 404ed without an Access JWT,
  // so an entry would not hand anyone the page — but the per-post URLs under it
  // are built from slugs, and every scheduled draft has one. Publishing that
  // list is the single thing scheduled publishing exists to prevent, and it
  // would happen in a file crawlers are invited to read.
  //
  // The filter is in astro.config.mjs and shares isAdminPath with middleware, so
  // this catches the filter being dropped rather than the predicate being wrong
  // — src/lib/admin-path.test.js covers the predicate.
  // Globbed rather than named, and NOT guarded by existence — same argument as
  // the CSS bundle below. `if (!existsSync) continue` over a fixed list would
  // drop this assertion from the run entirely the day the integration emits
  // sitemap-1.xml, or renames the file, or a config change stops emitting one:
  // the check that matters most would go quiet with nothing red. Assert the
  // files are found, then assert what they say.
  const sitemaps = readdirSync(DIST).filter((f) => /^sitemap.*\.xml$/.test(f));
  check(
    'sitemap: at least one sitemap file is emitted',
    sitemaps.length > 0,
    'no sitemap*.xml in dist/client — the /admin assertions below would have been vacuous',
  );
  for (const name of sitemaps) {
    check(
      `sitemap: ${name} does not name /admin`,
      !readFileSync(resolve(DIST, name), 'utf8').includes('/admin'),
      'the Desk is in the sitemap — with it, the slug of every scheduled draft',
    );
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

  // The interior-page section label must stay scoped to a section's own
  // heading. As a bare `.page h2` it reached every component rendered inside a
  // .page: .post-entry-title lost to it outright (index titles at 0.88rem in
  // accent small-caps), and .post-body h2 inherited the all-small-caps and
  // smcp/c2sc it doesn't itself declare — which is the "headings styled as
  // labels" of finding 1.1 and the "titles are the third thing you see" of 2.1,
  // both surviving a change to the component rules because those rules never
  // won. Nothing else in this suite can see it: it is a cascade outcome, not
  // markup, so the live matrix reads exactly the same either way, and the
  // symptom is a page that renders — just wrongly.
  check(
    'css: section-label rule is scoped to .page > section > h2',
    css.includes('.page>section>h2{') && !/[^>]\.page h2\{/.test(css),
    'a bare `.page h2` rule is back in the bundle — it will swallow post and entry headings',
  );

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

  // The Desk's styles, for the same reason and against the same mechanism.
  // src/layouts/Desk.astro keeps its rules out of global.css precisely so they
  // stay off every public page, and Astro decides that from the module graph —
  // so a single import of Desk.astro (or of a component that pulls it in) from
  // anything public ships the whole operator stylesheet site-wide.
  //
  // THE HTML CHECK IN live-desk.mjs DOES NOT COVER THIS, which is the whole
  // reason for a second assertion. That one greps public HTML for `desk-`; a
  // hoisted stylesheet appears there as `<link href="/_astro/….css">` and
  // carries no `desk-` substring at all, so the leak would be invisible to it
  // while every reader paid for it. Exactly how the galley bug above shipped.
  check(
    'css: desk styles are not in the public bundle',
    !/desk-/.test(css),
    'Desk CSS was hoisted into a route stylesheet — something public now imports ' +
      'src/layouts/Desk.astro, directly or through a component',
  );
}
