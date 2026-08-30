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
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { check, stripComments } from './check.mjs';
import { DIST, FIXTURE_SLUG, GALLEY_WRITE_QUOTA, PUBLISHED_SLUG } from './config.mjs';
import { BUILT_WITH, SET_IN, TAGLINE } from '../../src/lib/identity.js';

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

  // The fixture slug used to be declared twice — here and in blog.ts — and was
  // pinned by a grep at this spot, the way preview.js's WORKER_NAME is pinned
  // against wrangler.jsonc. It is now declared once, in src/lib/archive.js, and
  // both sides import it: config.mjs can, because that module is plain JS and
  // holds no astro:content import. There is nothing left here to drift.
  //
  // What blog.ts must still do is CALL the rule, the same shape as the
  // getPublishedPosts/isPublished check below — archive.test.js proves the
  // fixture is skipped, and would stay green if nothing asked it to be.
  check(
    'blog.ts features and neighbours posts through archive.js',
    /from '\.\/archive\.js'/.test(blogLibSource)
      && /\blatestIn\(/.test(blogLibSource)
      && /\badjacentIn\(/.test(blogLibSource),
    'blog.ts stopped calling latestIn/adjacentIn — the fixture-skip is unit-tested but no longer wired',
  );

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

    // og:image is gated on the BUILD's clock, not the request's, and the two
    // are not interchangeable. scripts/make-post-og.mjs writes a card only for
    // a post that was published when it ran; a post that goes live by its
    // pubDate passing — with no deploy behind it, which is the whole scheduled-
    // publishing mechanism — would otherwise start advertising a card nobody
    // generated, 404ing for every scraper during the manual syndication window.
    //
    // Nothing else can see this. At build time `scheduled` and `hasCard` agree
    // by construction, so the built HTML is identical and every artifact check
    // passes; the divergence only opens hours later, in production.
    check(
      'BlogPost.astro: og:image is gated on the build clock',
      /isPublished\(\s*pubDate\s*,\s*__BUILD_TIME__\s*\)/.test(layoutSource) &&
        /ogImage=\{hasCard\s*\?/.test(layoutSource),
      'the og:image gate no longer asks whether make-post-og.mjs generated a card — ' +
        'a post publishing between deploys would link an /og/<slug>.png that does not exist',
    );
  }

  // THE NEWSLETTER'S STATUS LINE IS A SIBLING OF THE FORM, NOT A CHILD, AND
  // public/scripts/newsletter.js MUST LOOK IT UP ACCORDINGLY.
  //
  // Subscribe.astro renders <form>, the Turnstile mount and <p class=
  // "newsletter-msg"> as three children of one <aside>, so the form stays a
  // single flex row and replaceWith() on success doesn't take the status line
  // with it. When the msg lookup was still `form.querySelector(...)` it
  // returned null, and the first `msg.` access threw — after preventDefault, so
  // the form did nothing at all: no request, no message, no disabled button, on
  // /blog and at the foot of every published post.
  //
  // Nothing else in this suite could see it. There is no browser here, the HTML
  // is unchanged by the bug, and the endpoint it never called is tested
  // directly. Both halves are needed: a script searching from the form, or a
  // component that stopped rendering the element, break it the same way.

  const subscribeSource = source(resolve('src/components/Subscribe.astro'));
  const newsletterClient = source(resolve('public/scripts/newsletter.js'));
  if (subscribeSource && newsletterClient) {
    check(
      'Subscribe.astro: renders the .newsletter-msg status line',
      /class="newsletter-msg"/.test(subscribeSource),
      'the status line is gone from Subscribe.astro — newsletter.js writes every message into it',
    );
    check(
      'newsletter.js: resolves .newsletter-msg from the component root, not the form',
      /closest\(\s*['"]aside['"]\s*\)/.test(newsletterClient) &&
        !/form\.querySelector\(\s*['"]\.newsletter-msg/.test(newsletterClient),
      'newsletter.js scopes the status-line lookup to the <form>, where the element is not — ' +
        'the handler throws after preventDefault and the form silently does nothing',
    );
  }

  // THE SITE-LEVEL OG CARD CARRIES IDENTITY ONLY, NEVER A FACT ABOUT TODAY.
  //
  // Social scrapers cache by image URL and effectively never re-fetch, so a
  // card asserting where I live is wrong the moment that moves AND the
  // correction cannot reach the caches already holding it. This shipped: the
  // card read "Brooklyn, New York" for months after the masthead said Lisbon,
  // because scripts/make-og.mjs is a manual `just og` step rather than a build
  // step and nothing compared the two.
  //
  // Nothing else here can see it. checkBuildArtifacts asserts og.png EXISTS and
  // live-site.mjs asserts the meta tag POINTS at it; neither reads a pixel, and
  // no test in this repo can read text out of a PNG. So the invariant is
  // enforced on the generator's source instead — a diagnostic, per this file's
  // header, but it is the only thing standing here at all.
  //
  // `source()` strips comments first, so the prose above explaining WHY the
  // location is absent cannot trip the check asserting it is absent.
  const ogGenSource = source(resolve('scripts/make-og.mjs'));
  if (ogGenSource) {
    check(
      'make-og.mjs: the site card states no fact about the present',
      !/meta-loc|Brooklyn|Lisbon|Barcelona|edition\.js|\bissue\(/.test(ogGenSource),
      'scripts/make-og.mjs states a fact about the present again — a location, or an ' +
        'edition line. The site-level card must carry ' +
        'identity only (avatar, name, tagline, domain). A per-post card may carry a ' +
        'date because that is a fact about the POST, pinned to a pubDate that never ' +
        'moves; anything on this card is a fact about today, and a stale one cannot ' +
        'be recalled from the scrapers that cached it. The edition line is in this ' +
        'pattern for the same reason: it was left out by a comment alone, and a comment ' +
        'is not a check',
    );
  }

  // THE MASTHEAD SENTENCES ARE SAID IN TWO ENGINES AND SPELLED IN ONE PLACE.
  //
  // Base.astro renders the tagline and colophon as HTML; make-og.mjs renders
  // them into the SVG behind public/og.png. src/lib/identity.js is the single
  // spelling. Inlining either string back into either renderer restores the
  // drift that put "Brooklyn, New York" on the card for months — and on the
  // card side it is invisible, because that generator is a manual `just og`
  // step and no test in this repo can read text out of a PNG.
  //
  // Checked as "the literal does not appear" rather than "the import does",
  // because an import that is present but unused is exactly what a re-inlining
  // leaves behind.
  //
  // `&amp;` is folded back to `&` first, or the colophon half slips through:
  // identity.js stores plain text (escaping is the renderer's job), so a
  // re-inlined "Set in Fraunces &amp; Source Serif" in markup does not contain
  // the constant as written. Caught by fault injection — without the fold, that
  // exact regression left this check green.
  for (const [label, path] of [
    ['make-og.mjs', 'scripts/make-og.mjs'],
    ['Base.astro', 'src/layouts/Base.astro'],
  ]) {
    const src = source(resolve(path)).replaceAll('&amp;', '&');
    check(
      `${label}: masthead sentences come from src/lib/identity.js`,
      Boolean(src) &&
        src.includes('identity.js') &&
        !src.includes(TAGLINE) &&
        !src.includes(SET_IN),
      src
        ? `${path} spells the tagline or colophon itself instead of importing it — ` +
          'the page and the OG card then drift independently, and the card is the ' +
          'half that drifts silently'
        : `${path} could not be read — it has moved or been renamed, and this check ` +
          'is blind until the path here follows it',
    );
  }

  // THE COLOPHON IS SAID IN A THIRD ENGINE, AND THAT ONE CANNOT IMPORT.
  //
  // docs/buttondown-rss-template.md is pasted by hand into Buttondown's
  // RSS-to-email Template field, so it spells the colophon as literal markdown
  // and no amount of restructuring will let it read identity.js. That makes it
  // the drift risk this module exists to remove, one surface further out: the
  // sentence can change here and the mailing keeps the old one until someone
  // remembers to re-paste, and nothing in this repo serves that file to notice.
  //
  // So the assertion runs the other way round from the two above — the literal
  // must be PRESENT and must match, rather than absent. A failure here does not
  // mean the template is broken; it means identity.js moved and the dashboard
  // copy is now stale. Fix by updating the template and re-pasting it.
  //
  // TAGLINE is not checked: the email carries a byline, not a masthead, so the
  // template never spells it.
  const emailTemplate = source(resolve('docs/buttondown-rss-template.md')).replaceAll(
    '&amp;',
    '&',
  );
  check(
    'buttondown-rss-template.md: the colophon still matches src/lib/identity.js',
    Boolean(emailTemplate) &&
      emailTemplate.includes(SET_IN) &&
      emailTemplate.includes(BUILT_WITH),
    emailTemplate
      ? 'the email template no longer spells the colophon the way identity.js does — ' +
        'update docs/buttondown-rss-template.md and re-paste it into Buttondown, or ' +
        'the mailing keeps saying the old sentence with nothing here to show it'
      : 'docs/buttondown-rss-template.md could not be read — it has moved or been ' +
        'renamed, and this check is blind until the path here follows it',
  );

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

  // THE ogImage DEFAULT AND THE FILE ON DISK, PINNED TOGETHER.
  //
  // Base.astro's default carries a `?v=` cache-bust (see the comment there), so
  // the string in the layout is no longer literally a path. That query is also
  // what would hide a rename: bump the filename without regenerating, and every
  // non-post page advertises a card that 404s for every scraper, while the
  // `asset: og.png` check above stays green against the OLD file still sitting
  // in public/. This is the half that does not rot — it resolves whatever the
  // layout actually says, query stripped, and requires it to be on disk.
  //
  // A scraper is the only consumer and it never reports a failure to us; a
  // broken og:image shows up as a missing preview on someone else's timeline,
  // days later, during the manual syndication window.
  const ogDefault = source(resolve('src/layouts/Base.astro')).match(
    /ogImage:\s*ogImagePath\s*=\s*['"]([^'"]+)['"]/,
  );
  check(
    'Base.astro: the default og:image names a card that exists',
    Boolean(ogDefault) && existsSync(resolve(DIST, ogDefault[1].split('?')[0].replace(/^\//, ''))),
    ogDefault
      ? `Base.astro defaults og:image to ${ogDefault[1]}, which is not in dist/client — ` +
        'every non-post page advertises a card no scraper can fetch'
      : 'could not find the ogImage default in src/layouts/Base.astro — this check is blind',
  );

  // THE PER-POST OG CARDS, IN BOTH DIRECTIONS. BlogPost.astro advertises
  // /og/<slug>.png for any post published as of __BUILD_TIME__; this is the only
  // thing that looks at whether scripts/make-post-og.mjs actually wrote one.
  //
  // The source guard above pins the GATE — that the layout still asks the build
  // clock rather than the request's — and live-site.mjs pins the meta TAG. Both
  // are satisfied by a build that emitted no cards at all: make-post-og.mjs
  // resolves its paths from cwd, so a moved content directory or a glob change
  // makes listPostSlugs() return [], and the script logs "wrote 0 card(s)",
  // exits 0, and lets `&&` chain on to a successful build in which every
  // published post links an image that 404s for every scraper.
  const publishedCard = resolve(DIST, 'og', `${PUBLISHED_SLUG}.png`);
  check(
    `og card: ${PUBLISHED_SLUG}.png was generated`,
    existsSync(publishedCard) && statSync(publishedCard).size > 1024,
    'no per-post OG card in dist/client/og — every post advertises an og:image that does not exist',
  );
  // The other direction is a disclosure, not a 404: a card carries the post's
  // TITLE, and /og/<slug>.png is a guessable URL with no token in front of it.
  // Generating one for a scheduled draft hands that draft's title to anyone who
  // guesses the slug — which is the one thing scheduled publishing exists to
  // prevent, and unlike a cover image (hash-named by astro:assets) this path is
  // derived from the slug and therefore trivially reachable.
  check(
    'og card: the scheduled fixture has NO card',
    !existsSync(resolve(DIST, 'og', `${FIXTURE_SLUG}.png`)),
    "a scheduled draft's OG card is on disk — its title is readable at a guessable URL",
  );

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
  //
  // BOTH HALVES MATCH A SELECTOR LIST, NOT JUST A LONE SELECTOR. Lightning CSS
  // merges rules that share a declaration block, so the bare rule can come back
  // as `.page h2,.something{` — no brace directly after the `h2`, which the
  // old `\{` anchor did not match, so the guard read green with the rule live.
  // Same reason the positive half is a regex now: merged into a list it would
  // have failed, which is the safe direction but still a red for the wrong
  // reason. The `(^|[^>])` is what keeps `.page>section>h2` from matching the
  // negative pattern; the alternation covers offset 0, where `[^>]` alone
  // cannot match because there is no preceding character.
  check(
    'css: section-label rule is scoped to .page > section > h2',
    /\.page>section>h2[,{]/.test(css) && !/(^|[^>])\.page h2[,{]/.test(css),
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
