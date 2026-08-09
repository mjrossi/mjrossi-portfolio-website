// "Can the draft inventory leak" — the Desk, over HTTP.
//
// /admin is the first unscoped surface in this repo: one page listing every
// scheduled draft, every reviewer label and every outstanding link, where a
// preview link grants exactly one post. So the negative direction is the
// assertion that matters most here, and it is checked from three angles that
// fail independently — no token at all, a token from a DIFFERENT Access
// application on the same team, and an expired one.
//
// The positive direction matters for a different reason. src/lib/access.js is a
// well-unit-tested pure function, but nothing in those tests proves it is still
// WIRED to the routes — a gate deleted from middleware fails closed in every
// unit test and opens the Desk to the world. Same argument as the preview-host
// matrix, and the same shape: prove both directions against the running worker.
//
// The tokens are minted by scripts/smoke/access.mjs against a keypair generated
// for this run and handed to the worker as ACCESS_JWKS_OVERRIDE.
import { check, checkHeader, checkStatus } from './check.mjs';
import { accessHeader, mintAccessJwt, OTHER_AUD } from './access.mjs';
import { BASE, FIXTURE_SLUG, PUBLISHED_SLUG, SMOKE_REVIEWER_TWO } from './config.mjs';
import { LINKS, NOTES } from './fixtures.mjs';

const DESK = `${BASE}/admin/`;

/** GET with an Access token, draining the body and returning it with the response. */
async function get(url, token) {
  const res = await fetch(url, token ? { headers: accessHeader(token) } : undefined);
  return { res, body: await res.text() };
}

export async function checkDesk() {
  // ── the gate, closed ───────────────────────────────

  const [bare, deskPost] = await Promise.all([
    get(DESK),
    get(`${BASE}/admin/${FIXTURE_SLUG}/`),
  ]);
  checkStatus('desk: 404s with no Access token', bare.res, 404);
  checkStatus('desk: a post page 404s with no Access token', deskPost.res, 404);
  check(
    'desk: an unauthorised response names no draft',
    !bare.body.includes(FIXTURE_SLUG) && !deskPost.body.includes(FIXTURE_SLUG),
    'the 404 body carried a slug it was refusing to show',
  );

  // The case a signature check alone cannot catch, and the reason access.js
  // compares `aud` at all: Access signs per TEAM, so a token minted for another
  // application on the same account verifies perfectly. This account has one —
  // the app covering preview-URL hostnames, whose policy is the looser of the
  // two by design.
  const wrongApp = await mintAccessJwt({ aud: OTHER_AUD });
  const wrongAppRes = await get(DESK, wrongApp);
  checkStatus(
    'desk: a valid token for ANOTHER Access app still 404s',
    wrongAppRes.res,
    404,
    'the aud check is not being enforced — any app on the team opens the Desk',
  );

  // Expiry, from a token that is otherwise perfect.
  const expired = await mintAccessJwt({ expiresInSec: -60 });
  checkStatus('desk: an expired token 404s', (await get(DESK, expired)).res, 404);

  // Garbage, to prove the parser fails closed rather than throwing a 500 — the
  // difference matters, because a 500 on /admin would confirm the route exists.
  for (const [name, token] of [
    ['malformed', 'not-a-jwt'],
    ['unsigned', 'eyJhbGciOiJub25lIn0.eyJhdWQiOlsieCJdfQ.'],
  ]) {
    checkStatus(`desk: a ${name} token 404s`, (await get(DESK, token)).res, 404);
  }

  // ── the gate, open ─────────────────────────────────

  const token = await mintAccessJwt();
  const { res: index, body: indexHtml } = await get(DESK, token);
  checkStatus('desk: a valid Access token opens it', index, 200);

  // The two headers that keep the whole inventory out of shared storage and out
  // of a search index. Overridden by middleware rather than set-if-absent,
  // because the value being replaced (max-age=3600) is exactly the failure.
  checkHeader('desk: not cached', index, 'cache-control', 'no-store');
  checkHeader('desk: not indexed', index, 'x-robots-tag', 'noindex');

  // It has to actually be the Desk, not a 200 from somewhere else. The fixture
  // post is permanently future-dated, so it is always outstanding.
  check(
    'desk: lists the scheduled fixture post',
    indexHtml.includes(FIXTURE_SLUG),
    'the index rendered without the one post that is always outstanding',
  );
  check(
    'desk: marks it scheduled',
    indexHtml.includes('desk-badge-scheduled'),
    'a scheduled draft rendered without its badge',
  );
  check(
    'desk: ships no client JavaScript',
    !/<script(?![^>]*type=["']application\/ld\+json)/i.test(indexHtml),
    'the Desk grew a script tag — it is read-only, so it needs none, and the ' +
      'site-wide CSP has no carve-out for one',
  );

  // ── one post ───────────────────────────────────────

  const { res: postRes, body: postHtml } = await get(`${BASE}/admin/${FIXTURE_SLUG}/`, token);
  checkStatus('desk: the post page opens with a valid token', postRes, 200);
  checkHeader('desk: the post page is not cached', postRes, 'cache-control', 'no-store');
  check(
    'desk: the post page lists the fixture’s review link',
    postHtml.includes(LINKS.review.id),
    'the roster rendered without a link the fixtures seeded',
  );
  check(
    'desk: a revoked link stays listed rather than vanishing',
    postHtml.includes(LINKS.revoked.id),
    'an inventory that forgets a withdrawn link is not an inventory',
  );
  check(
    'desk: the expired fixture link reads expired, not live',
    postHtml.includes(LINKS.expiredRow.id) && postHtml.includes('desk-state-expired'),
    'the row-expiry half of linkState is not reaching the page',
  );

  // ── the notes ──────────────────────────────────────
  //
  // Rendered from the same reviewModel `just galley` writes its markdown from,
  // so these assertions are about the WIRING rather than the model — the model's
  // own decisions are unit-tested in galley-render.test.js.

  check(
    'desk: shows an open note with its id',
    postHtml.includes(NOTES.current.id),
    'the manifest id is missing, so the page cannot be reconciled with a pull',
  );
  check(
    'desk: shows a second reviewer’s note',
    postHtml.includes(NOTES.stale.id) && postHtml.includes(SMOKE_REVIEWER_TWO),
    'the Desk is scoping notes to one reviewer — a pull covers everyone',
  );
  check(
    'desk: flags the note written against an older revision',
    postHtml.includes('revision drift'),
    'a stale note is being shown as though its line numbers still meant something',
  );
  check(
    'desk: a closed note is not among the open ones',
    postHtml.indexOf(NOTES.closed.id) > postHtml.indexOf('closed in earlier rounds'),
    'a note from a finished round is back in the working set',
  );

  // A published post: its links must read `spent`, which is the state that
  // stopped the roster answering "what is outstanding?" with "everything".
  const { body: publishedHtml } = await get(`${BASE}/admin/${PUBLISHED_SLUG}/`, token);
  check(
    'desk: a link on a published post reads spent',
    publishedHtml.includes('desk-state-spent'),
    'a link to a post anybody can already read is being reported as outstanding',
  );

  // A slug with no post is a state, not an error — it is exactly the link most
  // in need of revoking and the reason preview-roster grew --all.
  const { res: gone } = await get(`${BASE}/admin/no-such-post-anywhere/`, token);
  checkStatus('desk: a slug with no post still renders its roster', gone, 200);

  // A slug that cannot be a slug is refused before it reaches a query.
  const { res: bad } = await get(`${BASE}/admin/Not_A_Slug/`, token);
  checkStatus('desk: an unslug-shaped path 404s', bad, 404);
}

/**
 * The Desk must not have leaked into any public page.
 *
 * Its styles live in src/layouts/Desk.astro rather than global.css precisely so
 * they stay off the public bundle, and Astro decides that from the module graph
 * — which is the same mechanism that silently shipped galley CSS on every post
 * until GalleyMargin.astro's block was made `is:inline`. A future refactor that
 * lifts a Desk rule into global.css would be invisible without this.
 *
 * @param {{ homeHtml: string, blog: { html: string }, post: { html: string } }} routes
 */
export function checkDeskIsNotPublic({ homeHtml, blog, post }) {
  for (const [name, html] of [
    ['home', homeHtml],
    ['blog index', blog.html],
    ['a blog post', post.html],
  ]) {
    check(
      `desk: no desk- identifiers on ${name}`,
      !html.includes('desk-'),
      'operator chrome is reaching a public page',
    );
  }
}
