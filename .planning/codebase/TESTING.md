# Testing Patterns

**Analysis Date:** 2026-05-17

## Test Framework

**Runner:**
- No unit test framework (no Jest, Vitest, Mocha, etc.)
- Testing is exclusively integration/smoke testing via `scripts/smoke.mjs`
- Config: none — the smoke script is self-contained and invoked directly via Node

**Assertion Library:**
- Custom `check(name, ok, detail)` function defined in `scripts/smoke.mjs`
- No external assertion library

**Run Commands:**
```bash
npm run build && npm run smoke   # Full build + smoke test (always run together)
npm run smoke                    # Smoke only (uses existing dist/ — must build first)

# With mise (recommended):
MISE_ENV=development mise exec -- npm run build && npm run smoke

# Without mise:
PUBLIC_TURNSTILE_SITE_KEY=1x00000000000000000000AA npm run build && npm run smoke
```

## Test File Organization

**Location:**
- Single smoke test file: `scripts/smoke.mjs`
- No co-located unit tests — no `*.test.*` or `*.spec.*` files anywhere in the project

**Structure:**
```
scripts/
└── smoke.mjs          # All integration assertions
```

## Test Structure

**Two-phase design:**

**Phase 1 — Static artifact checks** (run before spawning wrangler):
- Assert that `dist/client/` was built and required assets are present
- Assert CSS bundle tokens (design system regression guards)
- Assert that `dist/client/_headers` was generated with the correct CSP
- Assert `fetchWithRetry` is still exported from `src/lib/server.ts` (named-export guard)

**Phase 2 — Live route checks** (spawns `wrangler dev` on port 8788):
- Fetches every on-demand HTML route
- Asserts shared chrome on all HTML pages via `assertSharedChrome()`
- Asserts route-specific behavior (form presence, redirects, RSS content)
- Asserts `/api/subscribe` sad-path contract via a test matrix
- Tears down wrangler on exit (SIGTERM → SIGKILL after 3s)

**Core assertion helper:**
```javascript
function check(name, ok, detail = '') {
  if (ok) {
    passes++;
    return;
  }
  fails.push({ name, detail });
}
```
- Never throws — collects all failures and reports them at the end
- `detail` is the diagnostic (e.g., actual vs. expected value)
- All failed checks are printed with `✗ name — detail`

**Shared chrome assertion:**
```javascript
function assertSharedChrome(label, res, html, activeHref) {
  check(`${label}: 200 OK`, res.status === 200, ...);
  check(`${label}: Cache-Control max-age=3600`, ...);
  check(`${label}: full masthead`, html.includes('class="masthead full"'));
  check(`${label}: edition line (Vol. X · No. Y · Month YYYY)`, /Vol\. [IVXLCDM]+.../.test(html));
  check(`${label}: no condensed-masthead residue`, ...);
  check(`${label}: ContactLinks rendered twice`, contactCount === 2, ...);
  check(`${label}: nav pill active on ${activeHref}`, ...);  // when activeHref provided
}
```
Called for every on-demand HTML route (home, work, education, urban-mobility, blog, blog post, tag page).

## Mocking

**Framework:** None

**What is mocked:**
- Nothing is mocked. The smoke test runs against the real built artifact via `wrangler dev`.
- Turnstile tokens: the always-passes Cloudflare test site key (`1x00000000000000000000AA`) is used at build time so the form renders, but actual Turnstile verification is not exercised (no real token available in CI)
- Buttondown API: not called during smoke — sad-path matrix only tests states before the Turnstile verify step, or uses the honeypot path

**What is NOT tested (by design):**
- Happy path for `/api/subscribe` (requires a real Turnstile token and real API keys)
- Buttondown API responses beyond the sad-path matrix
- Client-side JavaScript behavior (`public/scripts/newsletter.js`)

## Fixtures and Factories

**Test Data:**
- No fixtures or factory functions
- Smoke test uses real content from `dist/` — whatever posts are in `src/content/blog/`
- One post is pinned by slug for a specific assertion:

```javascript
// Lock in the <Figure> contract: the Netherlands cycling post embeds three
// <Figure> components, each of which must render a <figcaption>.
const figurePost = await fetchRoute('/blog/how-the-netherlands-got-me-back-on-a-bike/');
check(
  'blog post (figures): renders >=3 figcaption elements',
  (figurePost.html.match(/<figcaption>/g) || []).length >= 3,
  ...
);
```

- Blog post slug and tag for live route checks are discovered dynamically from the index HTML (not hardcoded):

```javascript
const postSlug = blog.html.match(/href="\/blog\/(?!tag\/)([^"/]+)\//)?.[1];
const tag = blog.html.match(/href="\/blog\/tag\/([^"/]+)\//)?.[1];
```

**Location:**
- No separate fixtures directory. Test data is the built site output in `dist/`.

## Coverage

**Requirements:** No coverage tooling or targets enforced.

**What smoke covers:**
- Every on-demand HTML route (200 status, shared chrome, cache headers, CSP)
- Every static asset in `dist/client/` (existence checks)
- CSS design token values in the built bundle (`--accent`, `--max`)
- `/api/contact` redirect contract (302, Location header, Cache-Control)
- `/api/subscribe` sad-path matrix (405, 415, 400/invalid email, 400/missing token, 403/CSRF, 200/honeypot)
- Payload size guard (2.5KB token not rejected as 413)
- Newsletter form scoping (present on `/blog`, absent on `/`)
- CSP header presence and correctness on HTML responses
- RSS feed existence and item count
- Figure component rendering count on a specific post

**What smoke does NOT cover:**
- Happy-path subscription flow
- Client-side JavaScript behavior
- Unit-level logic in `src/lib/` functions (edition line math, reading time, Roman numeral conversion)
- Content rendering beyond markup presence checks

## Test Types

**Unit Tests:**
- None. No unit test framework is installed.

**Integration Tests (Smoke):**
- `scripts/smoke.mjs` — the entire test suite
- Exercises the full built artifact: static files via filesystem reads + on-demand routes via real HTTP against `wrangler dev`
- No mocking — tests the real worker with real Cloudflare adapter behavior

**E2E Tests:**
- Not used. The smoke test covers the same surface at the HTTP response level without a browser.
- Lighthouse CI (`github/workflows/lighthouse.yml`) runs against Cloudflare preview deploys for performance auditing — not part of the smoke suite.

## Parallelism

Smoke leverages `Promise.all` for independent requests to reduce wall time:

```javascript
// Top-level pages fetched in parallel
const topResults = await Promise.all(topRoutes.map(([, path]) => fetchRoute(path)));

// Blog chain and RSS fetched in parallel after index
const [post, tagPage, rss] = await Promise.all([
  postSlug ? fetchRoute(`/blog/${postSlug}/`) : Promise.resolve(null),
  tag ? fetchRoute(`/blog/tag/${tag}/`) : Promise.resolve(null),
  fetchRoute('/blog/rss.xml'),
]);

// Subscribe sad-path matrix + privacy fetched in parallel
const subscribeResults = await Promise.all(
  subscribeCases.map((c) => fetchExpectingNon5xx(`${BASE}/api/subscribe`, c.init)),
);
```

## Retry Handling

The smoke test has its own retry wrapper for the subscribe sad-path matrix to handle `wrangler dev` transient 503s under rapid serial POSTs in CI:

```javascript
async function fetchExpectingNon5xx(url, init) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, init);
    await res.text(); // drain body, release connection
    if (res.status < 500) return res;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Final attempt — return whatever, let the assertion fail with the status
  const res = await fetch(url, init);
  await res.text();
  return res;
}
```

## Common Patterns

**Static HTML assertion:**
```javascript
check('blog index: newsletter form present', /id="newsletter-form"/.test(blog.html));
check('css: --accent is #8f5520 (AA contrast)', /--accent:\s*#8f5520/i.test(css));
```

**HTTP status assertion:**
```javascript
check(`${label}: 200 OK`, res.status === 200, `got ${res.status}`);
check('contact: 302 redirect', contact.status === 302, `got ${contact.status}`);
```

**Header assertion:**
```javascript
// Uses the headerContains helper:
function headerContains(res, name, value) {
  return (res.headers.get(name) ?? '').includes(value);
}
check(`${label}: Cache-Control max-age=3600`, headerContains(res, 'cache-control', 'max-age=3600'), ...);
```

**Occurrence count assertion:**
```javascript
// Uses the occurrences helper:
function occurrences(haystack, needle) { ... }
const contactCount = occurrences(html, 'aria-label="Contact"');
check(`${label}: ContactLinks rendered twice`, contactCount === 2, `found ${contactCount}`);
```

**Ordered position assertion (DOM ordering without a parser):**
```javascript
const followNoteIdx = blog.html.indexOf('class="blog-follow-note"');
const newsletterCloseIdx = blog.html.indexOf('</aside>');
check(
  'blog: follow note is OUTSIDE the newsletter aside',
  followNoteIdx > 0 && newsletterCloseIdx > 0 && followNoteIdx > newsletterCloseIdx,
  ...
);
```

## Adding New Smoke Assertions

1. Add new `check(...)` calls inside the `try` block in `scripts/smoke.mjs`
2. For new on-demand routes, call `fetchRoute('/new-path')` then `assertSharedChrome(...)` and route-specific checks
3. For new static assets, add to the `for...of` asset existence loop near the top of the script
4. For new CSS design tokens, add a `check('css: --token-name...', /regex/.test(css))` call in the CSS section
5. Always run `npm run build && npm run smoke` together — never test against a stale build
6. Update the assertion comment in `smoke.mjs` when the assertion reason is non-obvious

---

*Testing analysis: 2026-05-17*
