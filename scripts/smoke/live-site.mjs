// "Does the site work" — the public surfaces, over HTTP, against a running
// worker. The other half of the live suite (live-preview.mjs) asks the opposite
// question: can a draft leak.
//
// Split in two exported phases because the preview matrices run BETWEEN them in
// the original order, and that order is preserved so the failure report reads
// the same.
import { check, checkHeader, checkStatus, occurrences } from './check.mjs';
import { BASE } from './config.mjs';

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
  const contactCount = occurrences(html, 'aria-label="Contact"');
  check(`${label}: ContactLinks rendered twice`, contactCount === 2, `found ${contactCount}`);
  if (activeHref) {
    const activeRx = new RegExp(
      `<a[^>]*href="${activeHref}"[^>]*class="active"|<a[^>]*class="active"[^>]*href="${activeHref}"`,
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
  const figcaptions = (figurePost.html.match(/<figcaption>/g) || []).length;
  check(
    'blog post (figures): renders >=3 figcaption elements',
    figcaptions >= 3,
    `found ${figcaptions}`,
  );

  if (tagPage) {
    assertSharedChrome(`blog tag ${tag}`, tagPage.res, tagPage.html, '/blog');
    check(`blog tag ${tag}: lists at least one post`, /href="\/blog\/[^"/]+\//.test(tagPage.html));
  }

  checkRss(rss);
  return { homeHtml, blog, post };
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
    'contact: Location is mailto:hello@mjrossi.com',
    contact.headers.get('location') === 'mailto:hello@mjrossi.com',
    contact.headers.get('location') ?? '(none)',
  );
  checkHeader('contact: Cache-Control no-store', contact, 'cache-control', 'no-store');

  checkNewsletter(homeHtml, blog);
  await checkSubscribe();
}

function checkNewsletter(homeHtml, blog) {
  // Newsletter form on /blog only.
  check('blog index: newsletter form present', /id="newsletter-form"/.test(blog.html));
  check(
    'blog index: Turnstile script tag',
    /challenges\.cloudflare\.com\/turnstile\/v0\/api\.js/.test(blog.html),
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

  // The subscription fallback line ("Or follow by RSS · email me") must live
  // OUTSIDE the .newsletter <aside> so ad-block filter lists that target the
  // newsletter card don't hide it too. Regression guard against re-inlining
  // the fallback into the form fineprint.
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
  check('home: no newsletter form (JS carve-out scoped to /blog)', !/id="newsletter-form"/.test(homeHtml));
  check('home: no Turnstile script', !/challenges\.cloudflare\.com\/turnstile/.test(homeHtml));
}

async function checkSubscribe() {
  // Happy path needs a real Turnstile token (or Turnstile's documented test
  // secret in .dev.vars) so it's not in CI.
  //
  // Astro's built-in CSRF protection (security.checkOrigin) rejects POSTs
  // without a matching Origin at the framework layer, so the assertions below
  // pass an Origin header to exercise our handler rather than Astro's
  // middleware. (A missing Origin would correctly 403 — that's the desired
  // browser-facing behavior, just not what we're asserting here.)
  const ORIGIN = { Origin: BASE };
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
      // so this assertion specifically targets the form-style attack vector.
      name: '403 on form-encoded POST w/o Origin (CSRF guard)',
      init: { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a@b.co' },
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
