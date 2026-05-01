// Post-build smoke test. Reads dist/client/ and asserts markers that
// must exist (and some that must NOT exist). No test framework: every
// check here maps to a concrete regression we've actually hit.
// Run after `npm run build`. Exits 1 on the first failing assertion set.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const DIST = resolve('dist/client');
const fails = [];
let passes = 0;

function check(name, ok, detail = '') {
  if (ok) {
    passes++;
    return;
  }
  fails.push({ name, detail });
}

function readIfExists(path) {
  const full = resolve(DIST, path);
  return existsSync(full) ? readFileSync(full, 'utf8') : null;
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

if (!existsSync(DIST)) {
  console.error(`smoke: dist/client not found — run \`npm run build\` first`);
  process.exit(1);
}

// Routes that must render. `/` is excluded — it's on-demand (rendered in
// the Cloudflare worker, not prerendered to dist/client), so its
// assertions live in scripts/worker-smoke.mjs.
const routes = {
  work: 'work/index.html',
  education: 'education/index.html',
  urbanMobility: 'urban-mobility/index.html',
  blog: 'blog/index.html',
};

for (const [label, path] of Object.entries(routes)) {
  check(`route: ${label} renders`, existsSync(resolve(DIST, path)), path);
}

// Blog: at least one post, RSS feed, at least one tag index
const blogDir = resolve(DIST, 'blog');
const blogEntries = existsSync(blogDir) ? readdirSync(blogDir) : [];
const postSlugs = blogEntries.filter(
  (name) =>
    !['index.html', 'rss.xml', 'tag'].includes(name) &&
    existsSync(resolve(blogDir, name, 'index.html')),
);
check('blog: at least one post rendered', postSlugs.length > 0, `found ${postSlugs.length}`);

const rssPath = resolve(DIST, 'blog/rss.xml');
const rss = existsSync(rssPath) ? readFileSync(rssPath, 'utf8') : '';
check('blog: rss.xml exists',         existsSync(rssPath));
check('blog: rss.xml has <rss>',      rss.includes('<rss'));
check('blog: rss.xml has <channel>',  rss.includes('<channel>'));
check('blog: rss.xml has >=1 <item>', (rss.match(/<item>/g) || []).length >= 1);

const tagDir = resolve(DIST, 'blog/tag');
const tagEntries = existsSync(tagDir)
  ? readdirSync(tagDir).filter((name) => existsSync(resolve(tagDir, name, 'index.html')))
  : [];
check('blog: at least one tag page', tagEntries.length > 0, `found ${tagEntries.length}`);

// Each rendered tag page must actually list at least one post that links to
// a real post slug. Guards the tag pipeline end-to-end (getStaticPaths,
// getPostsByTag, render), not just existence.
for (const tag of tagEntries) {
  const html = readIfExists(`blog/tag/${tag}/index.html`) ?? '';
  check(`blog tag ${tag}: page rendered`, html.length > 0);
  const linksToPost = postSlugs.some((slug) => html.includes(`/blog/${slug}/`));
  check(`blog tag ${tag}: lists at least one post`, linksToPost);
}

// Sitemap references /blog (sitemap-0.xml is where individual URLs live;
// sitemap-index.xml just points at it)
const sitemap0 = readIfExists('sitemap-0.xml') ?? '';
check('sitemap: references /blog/',
  sitemap0.includes('https://mjrossi.com/blog/') ||
  sitemap0.includes('https://mjrossi.com/blog'),
);

// Static assets
for (const asset of ['noise.webp', 'profile-avatar.webp', 'favicon.svg', 'sitemap-index.xml', 'resume.pdf', 'og.png', '404.html']) {
  check(`asset: ${asset}`, existsSync(resolve(DIST, asset)));
}

// Home page markup is asserted against a live wrangler dev in
// scripts/worker-smoke.mjs — it's on-demand so there's no static HTML
// to read here.

// Interior pages
for (const label of ['work', 'education', 'urbanMobility', 'blog']) {
  const html = readIfExists(routes[label]) ?? '';
  check(`${label}: condensed masthead`,    html.includes('class="masthead condensed"'));
  check(`${label}: no full masthead`,      !html.includes('class="masthead full"'));
  check(`${label}: masthead-home-link`,    html.includes('masthead-home-link'));
  check(`${label}: masthead-page-label`,   html.includes('masthead-page-label'));
  check(`${label}: .page wrapper`,         /class="[^"]*\bpage\b[^"]*"/.test(html));
  check(`${label}: .page-header`,          html.includes('page-header'));
  check(
    `${label}: ContactLinks rendered twice`,
    occurrences(html, 'aria-label="Contact"') === 2,
    `found ${occurrences(html, 'aria-label="Contact"')}`,
  );
}

// Blog post page markup (using the first post found)
if (postSlugs.length > 0) {
  const postHtml = readIfExists(`blog/${postSlugs[0]}/index.html`) ?? '';
  check('blog post: article.post wrapper',   /<article[^>]*class="[^"]*\bpost\b/.test(postHtml));
  check('blog post: post-title rendered',    postHtml.includes('class="post-title"'));
  check('blog post: post-meta rendered',     postHtml.includes('class="post-meta"'));
  check('blog post: back link to /blog',     /href="\/blog"/.test(postHtml));
  check('blog post: top back link "← Blog"', /class="[^"]*post-back-top[^"]*"[^>]*>[^<]*←\s*Blog/.test(postHtml));
  check('blog post: reading time label',     /\d+\s*min\s*read/.test(postHtml));
  check('blog post: tag-chip class',         postHtml.includes('class="tag-chip"'));
  check('blog post: condensed masthead',     postHtml.includes('class="masthead condensed"'));
  check('blog post: no full masthead',       !postHtml.includes('class="masthead full"'));
}

// Blog index markup
const blogIndex = readIfExists('blog/index.html') ?? '';
check('blog index: rss-link rendered',       blogIndex.includes('class="rss-link"'));
check('blog index: rss-link points to feed', /class="rss-link"[^>]*href="\/blog\/rss\.xml"/.test(blogIndex)
  || /href="\/blog\/rss\.xml"[^>]*class="rss-link"/.test(blogIndex));
check('blog index: reading time label',      /\d+\s*min\s*read/.test(blogIndex));
check('blog index: post-count rendered',     blogIndex.includes('class="post-count"'));
check('blog index: tag-chip class',          blogIndex.includes('class="tag-chip"'));
check('blog index: legacy post-tag class gone', !/class="post-tag"/.test(blogIndex));

// Nav includes Blog link on every rendered page
for (const label of Object.keys(routes)) {
  const html = readIfExists(routes[label]) ?? '';
  check(`${label}: nav has Blog link`, /href="\/blog"[^>]*>\s*Blog\s*</.test(html));
}

// CSS bundle — pick the Base.*.css asset
const astroDir = resolve(DIST, '_astro');
const cssFile = existsSync(astroDir)
  ? readdirSync(astroDir).find(f => /^Base\..*\.css$/.test(f))
  : null;
check('css: Base.*.css exists', !!cssFile, cssFile ?? 'not found');

if (cssFile) {
  const css = readFileSync(join(astroDir, cssFile), 'utf8');
  check('css: --max token present',      /--max:\s*1100px/.test(css));
  check('css: --pad token present',      css.includes('--pad:'));
  check('css: --accent is #8f5520 (AA)', /--accent:\s*#8f5520/i.test(css));
  check('css: old #b86e2a accent gone',  !css.toLowerCase().includes('#b86e2a'));
  check('css: inline SVG data URI gone', !css.includes('data:image/svg+xml'));
  check('css: noise.webp referenced',    /url\(["']?\/noise\.webp["']?\)/.test(css));
  check('css: .nav-contact hides at mobile',
    /\.nav-contact\s*\{[^}]*display\s*:\s*none/.test(css) ||
    css.includes('.nav-contact{display:none}'),
  );
  check('css: .footer-contact order -1',
    /\.footer-contact\s*\{[^}]*order\s*:\s*-1/.test(css) ||
    css.includes('.footer-contact{order:-1}'),
  );
  check('css: no sub-12px font sizes',
    !/font-size:\s*\.(6[0-9]|7[0-4])\d*rem/.test(css),
  );
  check('css: media 699 present',        /@media\s*\(max-width:\s*699px\)/.test(css));
  check('css: media 639 present',        /@media\s*\(max-width:\s*639px\)/.test(css));
}

const total = passes + fails.length;
if (fails.length === 0) {
  console.log(`smoke: PASS (${passes}/${total} checks)`);
  process.exit(0);
}

console.error(`smoke: FAIL (${passes}/${total} checks, ${fails.length} failed)`);
for (const f of fails) {
  console.error(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
}
process.exit(1);
