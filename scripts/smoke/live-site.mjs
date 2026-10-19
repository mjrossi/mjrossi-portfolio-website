// "Does the site work" — the public surfaces, over HTTP, against a running
// worker. The other half of the live suite (live-preview.mjs) asks the opposite
// question: can a draft leak.
//
// Split in two exported phases because the preview matrices run BETWEEN them in
// the original order, and that order is preserved so the failure report reads
// the same.
import { check, checkHeader, checkStatus, occurrences } from './check.mjs';
import { BASE } from './config.mjs';
import { feedGuid } from '../../src/lib/feed-guid.js';
import { CARD_DESCRIPTION, CARD_TAGLINE, SITE_DESCRIPTION, TAGLINE } from '../../src/lib/identity.js';
import { CONTACT_EMAIL } from '../../src/lib/contact.js';
import { QR_PATH } from '../../src/lib/card-qr.js';

export async function fetchRoute(path) {
  const res = await fetch(`${BASE}${path}`);
  const html = await res.text();
  return { res, html };
}

/** Assertions that must hold on every on-demand HTML route. */
function assertSharedChrome(label, res, html, activeHref) {
  checkStatus(`${label}: 200 OK`, res, 200);
  checkHeader(`${label}: Cache-Control max-age=3600`, res, 'cache-control', 'max-age=3600');
  check(`${label}: full masthead`, html.includes('class="masthead full"'));
  check(
    `${label}: edition line (Vol. X · No. Y · Month YYYY)`,
    /Vol\. [IVXLCDM]+ · No\. [IVXLCDM]+ · \w+ \d{4}/.test(html),
  );
  // See the matching css-side guard in static.mjs — same prior-design regression.
  check(
    `${label}: no condensed-masthead residue`,
    !/masthead condensed|masthead-home-link|masthead-page-label/.test(html),
  );
  // Two mastheads, one paper: every blog route (they are exactly the routes
  // whose active nav entry is /blog) carries the Lexicon's, everything else the
  // author's. A swap in either direction is the identity bug — the periodical
  // presented as the person, or a post presented as a page of the CV.
  const lexicon = activeHref === '/blog';
  check(
    `${label}: ${lexicon ? 'Lexicon' : 'author'} masthead`,
    lexicon
      ? html.includes('class="masthead full" data-masthead="lexicon"') && html.includes('The Urbanist <span class="surname">Lexicon</span>')
      : html.includes('class="masthead full" data-masthead="author"') && html.includes('Matthew <span class="surname">Rossi</span>'),
  );
  // The theme carve-out: an external, synchronous script in <head> on every
  // route, and the toggle it reveals rendered hidden — once, in the masthead
  // folio — so a reader without JS never meets a dead control. No inline script anywhere — the CSP
  // would refuse it and the carve-out is supposed to be a file.
  const headEnd = html.indexOf('</head>');
  check(
    `${label}: theme script in <head>`,
    headEnd > 0 && /<script src="\/scripts\/theme\.js"><\/script>/.test(html.slice(0, headEnd)),
  );
  const toggles = occurrences(html, 'class="theme-toggle" role="group" aria-label="Colour theme" hidden');
  check(`${label}: theme toggle rendered hidden, once`, toggles === 1, `found ${toggles}`);
  check(
    `${label}: no inline <script>`,
    !/<script(?![^>]*\bsrc=)(?![^>]*type=["']application\/ld\+json)[^>]*>/i.test(html),
  );
  // The kicker is a breadcrumb for interior pages. The two fronts and the blog
  // routes carry none: `/` and `/blog` are where a breadcrumb would start, and
  // posts and tag pages already have their own back links.
  const wantsKicker = activeHref !== null && activeHref !== '/blog';
  check(
    `${label}: kicker ${wantsKicker ? 'present' : 'absent'}`,
    html.includes('class="kicker"') === wantsKicker,
  );
  const contactCount = occurrences(html, 'aria-label="Contact"');
  check(`${label}: ContactLinks rendered twice`, contactCount === 2, `found ${contactCount}`);
  if (activeHref) {
    // `active` as a class TOKEN, not as the whole attribute. The nav link for
    // /blog also carries `nav-pinned` (it is the link held against the right
    // edge of the phone-width scrolling row), so `class="active"` matched the
    // other four routes and silently failed on the one this file checks most.
    // Written as a token match rather than a substring so `nav-active` or
    // `inactive` could never satisfy it either.
    const cls = 'class="(?:[^"]*\\s)?active(?:\\s[^"]*)?"';
    const activeRx = new RegExp(
      `<a[^>]*href="${activeHref}"[^>]*${cls}|<a[^>]*${cls}[^>]*href="${activeHref}"`,
    );
    check(`${label}: nav pill active on ${activeHref}`, activeRx.test(html));
  }
}

/**
 * Top-level pages, the blog chain, and RSS.
 *
 * @returns {Promise<{ homeHtml: string, blog: object, post: object|null }>}
 *   the responses later phases need — `post` for the galley's
 *   "absent from a published post" guard, `blog`/`homeHtml` for the newsletter
 *   and CSP assertions in checkEndpoints.
 */
export async function checkRoutes() {
  // Fetched in parallel — they're independent GETs and wrangler-dev parallelism
  // noticeably shaves wall time over a serial loop.
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

  // The home page passes no description, so it gets both defaults: the search
  // snippet may follow TAGLINE, but a link preview is held indefinitely by
  // whoever scraped it and must state identity only, like the card image.
  check(
    'home: meta description is SITE_DESCRIPTION (follows TAGLINE)',
    homeHtml.includes(`<meta name="description" content="${SITE_DESCRIPTION}">`),
  );
  for (const tag of ['property="og:description"', 'name="twitter:description"']) {
    check(
      `home: ${tag} is CARD_DESCRIPTION, not TAGLINE`,
      homeHtml.includes(`<meta ${tag} content="${CARD_DESCRIPTION}">`) &&
        !new RegExp(`<meta ${tag} content="[^"]*${TAGLINE.slice(1)}`, 'i').test(homeHtml),
    );
  }

  // Blog chain: pick a post + a tag off the index, then fetch both in parallel.
  const postSlug = blog.html.match(/href="\/blog\/(?!tag\/)([^"/]+)\//)?.[1];
  const tag = blog.html.match(/href="\/blog\/tag\/([^"/]+)\//)?.[1];
  check('blog index: links to at least one post', !!postSlug);
  check('blog index: links to at least one tag',  !!tag);

  const [post, tagPage, topics, rss] = await Promise.all([
    postSlug ? fetchRoute(`/blog/${postSlug}/`) : Promise.resolve(null),
    tag ? fetchRoute(`/blog/tag/${tag}/`) : Promise.resolve(null),
    fetchRoute('/blog/tags'),
    fetchRoute('/blog/rss.xml'),
  ]);

  if (post) {
    assertSharedChrome(`blog post ${postSlug}`, post.res, post.html, '/blog');
    check(`blog post ${postSlug}: back link to /blog`, /href="\/blog"/.test(post.html));
    checkPostFurniture(postSlug, post.html);
    // The index is newest-first, so postSlug is the newest published post and
    // therefore the one post with no "next" neighbour. That end of the nav must
    // render NOTHING — it used to carry a dead "Newest post" cell, which under
    // the NEXT → key reads as the next post's title in a cell that links
    // everywhere else, i.e. as a broken link. This is the only place smoke knows
    // which post is at an end of the archive, so it is the only place the
    // absence can be asserted; PostNav's other branch is covered by the
    // furniture check above, which pins the nav being present at all.
    const navStart = post.html.indexOf('class="post-nav"');
    const nav = navStart < 0 ? '' : post.html.slice(navStart, post.html.indexOf('</nav>', navStart));
    check(
      `blog post ${postSlug}: newest post has no "next" cell`,
      nav.length > 0 && !nav.includes('rel="next"') && !/Newest post|Oldest post/.test(nav),
      navStart < 0
        ? 'no .post-nav at all on the newest post'
        : 'a next cell or an end-of-archive placeholder is back on the newest post',
    );
    await checkOgCardServed(postSlug);
  }

  assertSharedChrome('blog topics', topics.res, topics.html, '/blog');
  check(
    'blog topics: lists topics with counts',
    /class="topic-row"/.test(topics.html) && /class="topic-count"/.test(topics.html),
  );
  check(
    'blog index: Topics pill links to /blog/tags',
    /href="\/blog\/tags"/.test(blog.html),
    'the index header has no Topics pill',
  );
  // The count line is gone (finding 4.1) — the Topics pill took its place.
  check('blog index: no "N posts" count line', !/class="post-count"/.test(blog.html));

  await checkRetiredTagRedirect();

  // Lock in the <Figure> contract: the Netherlands cycling post embeds three
  // <Figure> components, each of which must render a <figcaption>. If this
  // count drifts, either the component broke or the post was edited.
  const figurePost = await fetchRoute('/blog/how-the-netherlands-got-me-back-on-a-bike/');
  const figcaptions = (figurePost.html.match(/<figcaption>/g) || []).length;
  check(
    'blog post (figures): renders >=3 figcaption elements',
    figcaptions >= 3,
    `found ${figcaptions}`,
  );

  if (tagPage) {
    assertSharedChrome(`blog tag ${tag}`, tagPage.res, tagPage.html, '/blog');
    check(`blog tag ${tag}: lists at least one post`, /href="\/blog\/[^"/]+\//.test(tagPage.html));
    check(
      `blog tag ${tag}: links back to the topic index`,
      /href="\/blog\/tags"/.test(tagPage.html),
      'no "All topics" link — a reader who lands here can only go back',
    );
    check(`blog tag ${tag}: shows sibling topics`, /class="topic-siblings"/.test(tagPage.html));
  }

  checkRss(rss);
  return { homeHtml, blog, post };
}

/**
 * What the August 2026 review moved around a post: up to two topics in the meta
 * line rather than a chip row above the prose, the full set under "Filed under", the
 * subscribe card, and the previous/next pair.
 */
function checkPostFurniture(slug, html) {
  const bodyIdx = html.indexOf('class="post-body"');
  const header = bodyIdx > 0 ? html.slice(0, bodyIdx) : html;

  check(
    `blog post ${slug}: topics in the meta line`,
    /class="post-topic"/.test(header),
    'no .post-topic link before the post body',
  );
  // The cap is the whole point of the meta line — two topics instead of the six
  // chips of finding 1.4. Without this, "show the first N tags" can drift back
  // to N = all and quietly restore the clutter, and every other assertion here
  // would stay green.
  const headerTopics = occurrences(header, 'class="post-topic"');
  check(
    `blog post ${slug}: at most two topics`,
    headerTopics <= 2,
    `${headerTopics} topics in the meta line — the cap in PostTopics.astro moved`,
  );
  // Finding 1.4 — the chip row between the title and the first word of prose.
  check(
    `blog post ${slug}: no tag chips above the prose`,
    !/class="tag-chip"/.test(header),
    'a tag chip still renders in the post header',
  );
  check(
    `blog post ${slug}: "Filed under" chips in the footer`,
    /class="post-tags-label">Filed under</.test(html) && /class="tag-chip"/.test(html),
  );
  check(`blog post ${slug}: subscribe card at the end`, /class="subscribe-card"/.test(html));
  // Same blocker fallback as the index, and for the same reason: the card lives
  // in an <aside class="subscribe-card"> that a filter list will hide, so the
  // way out has to sit outside it.
  // Anchored on the CARD's own </aside>, not the document's first one. The two
  // are the same element today, which is exactly the problem: any <aside> added
  // earlier in a post — a pull quote, an editor's note — silently turns this
  // into "the follow note comes after some other aside", which is true of
  // almost any placement including the broken one.
  const cardIdx = html.indexOf('class="subscribe-card"');
  const cardCloseIdx = cardIdx < 0 ? -1 : html.indexOf('</aside>', cardIdx);
  const postNoteIdx = html.indexOf('class="blog-follow-note"');
  check(
    `blog post ${slug}: hand-add fallback outside the subscribe card`,
    postNoteIdx > 0 && cardCloseIdx > 0 && postNoteIdx > cardCloseIdx &&
      /class="blog-follow-note"[\s\S]{0,240}?\/api\/contact/.test(html),
    'no follow note after the card — a blocked card leaves the post with no way to subscribe',
  );
  check(`blog post ${slug}: previous/next nav`, /class="post-nav"/.test(html));
  // Per-post OG card (finding 3.4) — a published post must not fall back to the
  // site-level image, and its alt text must be the post's own.
  check(
    `blog post ${slug}: per-post og:image`,
    new RegExp(`property="og:image" content="[^"]*/og/${slug}\\.png"`).test(html),
    'og:image still points at the generic /og.png',
  );
}

/**
 * The card the post advertises has to be REACHABLE, not merely written. The
 * artifact check in static.mjs proves make-post-og.mjs put a file on disk;
 * this proves the deployed worker hands it back, which is the half that turns
 * on the ASSETS binding and public/.assetsignore rather than on the generator.
 *
 * A scraper is the only consumer, and it never reports a failure to us — a
 * broken og:image is visible as a missing preview card on someone else's
 * timeline, days after the fact, during the manual syndication window.
 */
async function checkOgCardServed(slug) {
  const res = await fetch(`${BASE}/og/${slug}.png`);
  // Drain it. An unread body leaves wrangler dev's ProxyWorker holding a stream
  // nobody consumes, which is what kills the runtime mid-run — see CLAUDE.md.
  await res.arrayBuffer();
  checkStatus(
    `blog post ${slug}: /og/${slug}.png is served`,
    res, 200,
    'the advertised og:image 404s — every social preview falls back to nothing',
  );
  // The content type is the half that catches a MISS specifically. An ASSETS
  // miss falls through to the worker, which answers with the 404 PAGE — 200 is
  // gone but a body-size floor here would not be: that HTML is comfortably
  // larger than the 1KB an empty PNG would trip, so it reads green while the
  // card is missing. Measured: with the file moved aside, status and this both
  // fail and a byteLength > 1024 check passed. Assert the disk size in
  // static.mjs, where the bytes are the file's own, and the type here.
  checkHeader(`blog post ${slug}: og card is a PNG`, res, 'content-type', 'image/png');
}

/**
 * A tag retired by the taxonomy consolidation must 301, not 404 — those URLs
 * were on a chip under every post that carried them.
 */
async function checkRetiredTagRedirect() {
  const res = await fetch(`${BASE}/blog/tag/urban-mobility/`, { redirect: 'manual' });
  await res.text();
  checkStatus('blog: retired tag 301s', res, 301);
  check(
    'blog: retired tag redirects to a live page',
    res.headers.get('location') === '/blog/',
    res.headers.get('location') ?? '(none)',
  );
}

function checkRss(rss) {
  checkStatus('rss: 200 OK', rss.res, 200);
  check('rss: has >=1 <item>', (rss.html.match(/<item>/g) || []).length >= 1);
  // RSS is on-demand (not prerendered), so it sets its own Cache-Control since
  // middleware only touches text/html responses.
  checkHeader('rss: Cache-Control max-age=3600', rss.res, 'cache-control', 'max-age=3600');
  // Going on-demand moved RSS out of the ASSETS binding, so it no longer
  // inherits dist/client/_headers — middleware must supply the security set
  // on non-HTML worker responses. Spot-check two; if these are missing the
  // middleware regressed to HTML-only gating.
  checkHeader('rss: X-Content-Type-Options nosniff', rss.res, 'x-content-type-options', 'nosniff');
  checkHeader('rss: Strict-Transport-Security present', rss.res, 'strict-transport-security', 'max-age=');

  // Scheduled-publishing invariant: the production feed must never contain a
  // post whose pubDate is still in the future. Guards the date filter in
  // getPublishedPosts() against regressions (this holds for all time, so it
  // won't rot as fixture dates pass).
  const rssNow = Date.now();
  const rssDates = [...rss.html.matchAll(/<pubDate>([^<]+)<\/pubDate>/g)].map((m) => Date.parse(m[1]));
  // Assert parseability separately — filtering NaN out silently would let a
  // malformed <pubDate> pass the future-date check rather than fail it.
  check(
    'rss: every pubDate parses',
    rssDates.every(Number.isFinite),
    `${rssDates.filter((t) => !Number.isFinite(t)).length} unparseable pubDate(s)`,
  );
  const futureRssItems = rssDates.filter((t) => Number.isFinite(t) && t > rssNow);
  check('rss: no future-dated items', futureRssItems.length === 0, `${futureRssItems.length} future item(s)`);

  // Every item's GUID must come from feedGuid(), not from `site`. The unit test
  // pins the function; this pins the call site — exactly one <guid> per item
  // (a duplicate means the override and the library default both landed), each
  // on GUID_ORIGIN and naming the same slug as its own <link>.
  const items = [...rss.html.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const guidMismatches = items.filter((item) => {
    const guids = [...item.matchAll(/<guid[^>]*>([^<]*)<\/guid>/g)].map((m) => m[1]);
    const slug = item.match(/<link>[^<]*\/blog\/([^/<]+)\/<\/link>/)?.[1];
    return guids.length !== 1 || !slug || guids[0] !== feedGuid(slug);
  });
  check(
    'rss: every item has one GUID from feedGuid()',
    items.length > 0 && guidMismatches.length === 0,
    `${guidMismatches.length} of ${items.length} item(s) off`,
  );
}

/**
 * Explicitly drain the response body (so the connection releases promptly) and
 * retry once on 5xx — wrangler dev / workerd has been observed returning
 * transient 503s under rapid serial POSTs in CI. Smoke shouldn't fail on
 * infrastructure flakes; we're asserting our endpoint's contract, not workerd's
 * reliability.
 */
async function fetchExpectingNon5xx(url, init) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, init);
    await res.text(); // drain body, release connection
    if (res.status < 500) return res;
    // 5xx — workerd transient. Wait briefly and retry.
    await new Promise((r) => setTimeout(r, 200));
  }
  // Final attempt — return whatever, let the assertion fail with the status.
  const res = await fetch(url, init);
  await res.text();
  return res;
}

/** /api/contact, the newsletter carve-out, CSP, /api/subscribe sad paths, /privacy. */
export async function checkEndpoints({ homeHtml, blog }) {
  // /api/contact — must 302 to mailto: so the address never appears in HTML.
  // fetch() can't follow mailto:, so request with redirect: 'manual'.
  const contact = await fetch(`${BASE}/api/contact`, { redirect: 'manual' });
  checkStatus('contact: 302 redirect', contact, 302);
  check(
    'contact: Location is mailto:CONTACT_EMAIL',
    contact.headers.get('location') === `mailto:${CONTACT_EMAIL}`,
    contact.headers.get('location') ?? '(none)',
  );
  checkHeader('contact: Cache-Control no-store', contact, 'cache-control', 'no-store');

  checkNewsletter(homeHtml, blog);
  await checkSubscribe();
}

function checkNewsletter(homeHtml, blog) {
  // The signup, placement A: a one-line band under the blog index header,
  // replacing the block that used to sit below the last entry (finding 2.2).
  check('blog index: newsletter form present', /id="newsletter-form"/.test(blog.html));
  check('blog index: subscribe band, not the old block', /class="subscribe-line"/.test(blog.html));
  check(
    'blog index: Turnstile script tag',
    /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/.test(blog.html),
  );
  // The band sits ABOVE the first entry — that placement is the whole argument
  // for it (always in view however long the archive gets), so it is worth
  // asserting rather than assuming.
  const bandIdx = blog.html.indexOf('class="subscribe-line"');
  const firstEntryIdx = blog.html.indexOf('class="post-entry"');
  check(
    'blog index: subscribe band is above the first entry',
    bandIdx > 0 && firstEntryIdx > 0 && bandIdx < firstEntryIdx,
    'the band renders below the archive again',
  );

  // CSP must be set on the HTML response (via middleware, since public/_headers
  // doesn't apply to on-demand routes on Workers+Assets). Without this, the
  // page ships with no CSP and any browser/extension-injected policy wins.
  const blogCsp = blog.res.headers.get('content-security-policy') ?? '';
  check('blog: Content-Security-Policy header set', blogCsp.length > 0, 'no CSP on /blog response');
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

  // The subscription fallback line must live OUTSIDE the subscribe <aside> so
  // ad-block filter lists that target the signup don't hide it too. Both halves
  // matter — RSS *and* a human who will add you by hand — because a reader whose
  // blocker ate the form is exactly the reader who never reaches /privacy to
  // find the offer there. §5 condensed the form's own fine print; it did not
  // mean to take this with it.
  check(
    'blog: follow note keeps the add-me-by-hand offer',
    /class="blog-follow-note"[\s\S]{0,240}?\/api\/contact/.test(blog.html),
    'the hand-add fallback is gone — a blocked form leaves no way to subscribe',
  );
  const followNoteIdx = blog.html.indexOf('class="blog-follow-note"');
  const newsletterCloseIdx = blog.html.indexOf('</aside>');
  check('blog: follow note present', followNoteIdx > 0, 'no blog-follow-note paragraph found');
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
  // The carve-out is wider than it was — placement D puts the same form at the
  // foot of every published post — but it is still scoped to the blog. The
  // front page is the guard against a lift into Base.astro or shared chrome.
  check('home: no newsletter form (JS carve-out scoped to the blog)', !/id="newsletter-form"/.test(homeHtml));
  check('home: no Turnstile script', !/challenges\.cloudflare\.com\/turnstile/.test(homeHtml));
  // Finding 4.3 — the periodical's name doing some work outside /blog.
  check('home: "From the Lexicon" block', /class="lexicon-teaser"/.test(homeHtml));
  // Finding 3.3 — the Now dateline, so a stale block is legible as stale.
  check('home: Now dateline', /class="section-updated">Updated \w+ \d{4}</.test(homeHtml));
}

async function checkSubscribe() {
  // Happy path needs a real Turnstile token (or Turnstile's documented test
  // secret in .dev.vars) so it's not in CI.
  //
  // Astro's built-in CSRF protection (security.checkOrigin) rejects cross-site
  // form POSTs at the framework layer, so the assertions below pass a
  // same-origin Origin header to exercise our handler rather than Astro's
  // middleware. Since Astro 7.4 the check reads Sec-Fetch-Site first and falls
  // back to Origin, and a request carrying *neither* is let through — no
  // browser sends a cross-site POST without one, so that request is not a
  // CSRF vector. The two CSRF cases therefore send what a browser would.
  const ORIGIN = { Origin: BASE };
  const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
  const jsonPost = (body) => ({
    method: 'POST',
    headers: { ...ORIGIN, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  // Every entry exercises a distinct contract. The honeypot must come after
  // happy-path-shaped inputs because its 200 response is the contract — not an
  // empty pass.
  const subscribeCases = [
    { name: '405 on GET', init: { method: 'GET', headers: ORIGIN }, expect: 405 },
    {
      name: '415 on non-JSON',
      init: { method: 'POST', headers: { ...ORIGIN, 'Content-Type': 'text/plain' }, body: 'hi' },
      expect: 415,
    },
    { name: '400 on invalid email', init: jsonPost({ email: 'not-an-email', turnstileToken: 'x' }), expect: 400 },
    { name: '400 on missing turnstile token', init: jsonPost({ email: 'a@b.co' }), expect: 400 },
    {
      // JSON POSTs require browser preflight and reach the handler regardless,
      // so these two target the form-style attack vector — one per branch of
      // Astro's check, so neither can regress unnoticed.
      name: '403 on cross-site form POST, Sec-Fetch-Site (CSRF guard)',
      init: { method: 'POST', headers: { ...FORM, 'Sec-Fetch-Site': 'cross-site' }, body: 'email=a@b.co' },
      expect: 403,
    },
    {
      name: '403 on cross-site form POST, foreign Origin (CSRF guard)',
      init: { method: 'POST', headers: { ...FORM, Origin: 'https://evil.example' }, body: 'email=a@b.co' },
      expect: 403,
    },
    {
      // A filled `company` field returns 200 silently so attackers can't tell
      // the field exists. Runs before Turnstile so the token is irrelevant.
      name: '200 on filled honeypot field',
      init: jsonPost({ email: 'bot@example.com', turnstileToken: 'x', company: 'ACME Corp' }),
      expect: 200,
    },
  ];

  // The matrix, the realistic-payload guard and the privacy fetch run in
  // parallel — none of them share state, and fetchExpectingNon5xx's one-shot
  // retry covers the POSTs workerd has historically flaked on.
  const subscribeResults = await Promise.all(
    subscribeCases.map((c) => fetchExpectingNon5xx(`${BASE}/api/subscribe`, c.init)),
  );
  subscribeResults.forEach((res, i) => {
    checkStatus(`subscribe: ${subscribeCases[i].name}`, res, subscribeCases[i].expect);
  });

  // Realistic-sized payload doesn't 413. Real Turnstile tokens are 2-4 KB;
  // the parseJson maxBytes cap must accommodate. Should return one of the 4xx
  // Turnstile codes, NEVER 413. Kept out of the table above because the
  // assertion is an inequality with a longer diagnostic message.
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
  checkStatus('privacy: 200 OK', privacy.res, 200);
  check('privacy: names Buttondown', /Buttondown/i.test(privacy.html));
  check('privacy: names Turnstile', /Turnstile/i.test(privacy.html));
}

/**
 * /card and the .vcf behind it — a route of its own kind, so it does NOT go
 * through assertSharedChrome: it is `bare`, with no masthead, nav, toggle or
 * footer, and a check that demanded them would be asserting the wrong page.
 * What it shares with every route is the <head> (theme.js, no inline script)
 * and the middleware (CSP, the hour's Cache-Control).
 */
export async function checkCard({ homeHtml }) {
  const { res, html } = await fetchRoute('/card');
  checkStatus('card: 200 OK', res, 200);
  checkHeader('card: Cache-Control max-age=3600', res, 'cache-control', 'max-age=3600');
  check('card: CSP header', Boolean(res.headers.get('content-security-policy')));
  const headEnd = html.indexOf('</head>');
  check(
    'card: theme script in <head>',
    headEnd > 0 && /<script src="\/scripts\/theme\.js"><\/script>/.test(html.slice(0, headEnd)),
  );
  check(
    'card: no inline <script>',
    !/<script(?![^>]*\bsrc=)(?![^>]*type=["']application\/ld\+json)[^>]*>/i.test(html),
  );
  check(
    'card: bare — no masthead, nav, toggle or footer',
    !html.includes('class="masthead') &&
      !html.includes('broadsheet-nav') &&
      !html.includes('class="theme-toggle"') &&
      !html.includes('class="site-foot"'),
  );
  // A regex, not the string the masthead check uses: the page's scoped <style>
  // stamps a data-astro-cid-* attribute on every element it styles.
  check('card: the wordmark', /Matthew <span class="surname"[^>]*>Rossi<\/span>/.test(html));
  // The page re-renders per request, so it may follow the masthead's TAGLINE.
  check('card: the masthead TAGLINE', html.includes(TAGLINE));
  // A text-thread preview keeps og:description indefinitely, like the OG card.
  check(
    'card: og:description is CARD_DESCRIPTION',
    html.includes(`<meta property="og:description" content="${CARD_DESCRIPTION}">`),
  );
  // Not the home page's title: both are indexable, and two pages sharing one
  // read as duplicates to a search engine and in a tab strip.
  check('card: its own <title>', html.includes('<title>Card — Matthew Rossi</title>'));
  // But a link preview in a text thread shows the name alone.
  check(
    'card: og:title and twitter:title are the name alone',
    html.includes('<meta property="og:title" content="Matthew Rossi">') &&
      html.includes('<meta name="twitter:title" content="Matthew Rossi">'),
  );
  // The one action that matters leads the list and is the button.
  check(
    'card: "Add to contacts" first, as the button',
    /<ul class="card-contact"[^>]*>\s*<li[^>]*><a class="card-add"[^>]*href="\/api\/vcard"/.test(html),
  );
  check('card: indexable (no robots meta)', !/<meta name="robots"/.test(html));
  for (const href of ['/api/vcard', '/api/contact', '/']) {
    check(`card: links ${href}`, html.includes(`href="${href}"`));
  }
  // The scanner lands here; a code pointing at the page they are on is useless
  // to them and competes with "Add to contacts". It lives on /card/qr.
  check(
    'card: no QR code — that is /card/qr',
    !html.includes(QR_PATH) && !html.includes('class="card-qr'),
  );
  // The rule /api/contact exists for: the address is never in a page. /card is
  // the one page linking both endpoints that carry it.
  check(
    'card: the address is not in the HTML',
    !html.includes(CONTACT_EMAIL) && !html.includes('mailto:'),
  );
  check('home: no nav link to /card', !homeHtml.includes('href="/card"'));

  // /card/qr, the presenter's view: the name and the code, nothing else.
  const qr = await fetchRoute('/card/qr');
  checkStatus('card/qr: 200 OK', qr.res, 200);
  checkHeader('card/qr: Cache-Control max-age=3600', qr.res, 'cache-control', 'max-age=3600');
  check('card/qr: CSP header', Boolean(qr.res.headers.get('content-security-policy')));
  const qrHeadEnd = qr.html.indexOf('</head>');
  check(
    'card/qr: theme script in <head>',
    qrHeadEnd > 0 && /<script src="\/scripts\/theme\.js"><\/script>/.test(qr.html.slice(0, qrHeadEnd)),
  );
  check(
    'card/qr: no inline <script>',
    !/<script(?![^>]*\bsrc=)(?![^>]*type=["']application\/ld\+json)[^>]*>/i.test(qr.html),
  );
  check(
    'card/qr: bare — no masthead, nav, toggle or footer',
    !qr.html.includes('class="masthead') &&
      !qr.html.includes('broadsheet-nav') &&
      !qr.html.includes('class="theme-toggle"') &&
      !qr.html.includes('class="site-foot"'),
  );
  check('card/qr: the wordmark', /Matthew <span class="surname"[^>]*>Rossi<\/span>/.test(qr.html));
  check('card/qr: inline QR path from src/lib/card-qr.js', qr.html.includes(`d="${QR_PATH}"`));
  // The tile must never invert under Night: --qr-tile / --qr-ink are Paper-only
  // (static.mjs asserts no Night block declares them), but that holds only while
  // the route fills from them. A fill of var(--bg) would pass every other check.
  check(
    'card/qr: tile and modules fill from the Paper-only QR tokens',
    /\.card-qr-tile[^{]*\{[^}]*fill:\s*var\(--qr-tile\)/.test(qr.html) &&
      /\.card-qr-ink[^{]*\{[^}]*fill:\s*var\(--qr-ink\)/.test(qr.html),
    'the scoped rules are no longer inlined, or no longer fill from --qr-tile / --qr-ink',
  );
  // Nothing to act on here: anyone but the presenter belongs on /card.
  const qrBodyAt = qr.html.indexOf('<body');
  const qrBody = qr.html.slice(qrBodyAt);
  check(
    'card/qr: no links or contact actions',
    qrBodyAt > 0 && !/<a\b/i.test(qrBody) && !qrBody.includes('/api/'),
  );
  // A search result that lands on a bare QR code helps nobody.
  check('card/qr: noindex', /<meta name="robots" content="noindex">/.test(qr.html));
  check('card/qr: the address is not in the HTML', !qr.html.includes(CONTACT_EMAIL) && !qr.html.includes('mailto:'));

  const vcf = await fetch(`${BASE}/api/vcard`);
  const body = await vcf.text();
  checkStatus('vcard: 200 OK', vcf, 200);
  checkHeader('vcard: Content-Type text/vcard', vcf, 'content-type', 'text/vcard; charset=utf-8');
  checkHeader('vcard: Content-Disposition inline', vcf, 'content-disposition', 'inline; filename="matthew-rossi.vcf"');
  checkHeader('vcard: Cache-Control no-store', vcf, 'cache-control', 'no-store');
  checkHeader('vcard: nosniff', vcf, 'x-content-type-options', 'nosniff');
  check(
    'vcard: CRLF throughout, every line within 75 octets',
    body.endsWith('\r\n') &&
      !/\r(?!\n)|(?<!\r)\n/.test(body) &&
      body.split('\r\n').every((line) => Buffer.byteLength(line, 'utf8') <= 75),
  );
  const unfolded = body.replace(/\r\n /g, '');
  check(
    'vcard: TITLE is CARD_TAGLINE, never TAGLINE',
    unfolded.includes(`\r\nTITLE:${CARD_TAGLINE}\r\n`) && !unfolded.includes(TAGLINE),
  );
  // Read back from the redirect rather than from CONTACT_EMAIL, so the two
  // endpoints are compared with each other and not each with the constant.
  const contact = await fetch(`${BASE}/api/contact`, { redirect: 'manual' });
  const mailto = (contact.headers.get('location') ?? '').replace(/^mailto:/, '');
  check(
    'vcard: EMAIL matches /api/contact',
    Boolean(mailto) && unfolded.includes(`\r\nEMAIL;TYPE=INTERNET:${mailto}\r\n`),
  );
  check('vcard: carries a JPEG PHOTO', /\r\nPHOTO;ENCODING=b;TYPE=JPEG:\/9j\//.test(unfolded));
}
