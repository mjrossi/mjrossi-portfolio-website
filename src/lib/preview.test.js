// Unit tests for the preview unlocks. Run via `npm test`.
//
// Same rationale as schedule.test.js: smoke can assert the wiring exists but
// cannot prove the crypto is right, and several of these cases (expiry,
// cross-slug reuse, wrong key) are exactly the ones a refactor would break
// silently. The suffix-confusion host cases matter because getting
// `.endsWith('.workers.dev')` subtly wrong is how a lookalike domain would
// start serving unpublished drafts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isPreviewHost,
  newLinkId,
  signPreviewToken,
  verifyPreviewGrant,
  verifyPreviewToken,
  WORKER_NAME,
} from './preview.js';

const KEY = 'test-signing-key-do-not-use-in-production';
const OTHER_KEY = 'a-different-signing-key';
const NOW = Date.parse('2026-07-20T12:00:00Z');
const SOON = Math.floor(NOW / 1000) + 3600; // one hour out

// ── isPreviewHost ────────────────────────────────────

test('production hosts are not preview hosts', () => {
  assert.equal(isPreviewHost('mjrossi.com'), false);
  assert.equal(isPreviewHost('www.mjrossi.com'), false);
});

test('local hosts are not preview hosts', () => {
  // Deliberate: smoke.mjs drives wrangler dev on 127.0.0.1, so localhost must
  // stay on the production code path or smoke stops guarding the real filter.
  assert.equal(isPreviewHost('127.0.0.1'), false);
  assert.equal(isPreviewHost('localhost'), false);
});

test('workers.dev branch/version deploy hosts are preview hosts', () => {
  assert.equal(isPreviewHost(`abc123-${WORKER_NAME}.link00seven.workers.dev`), true);
  assert.equal(isPreviewHost(`my-branch-${WORKER_NAME}.link00seven.workers.dev`), true);
});

test('the production workers.dev alias is NOT a preview host', () => {
  // Regression guard for the leak this check exists to close: Cloudflare
  // enables `<worker-name>.<subdomain>.workers.dev` by default, it serves
  // PRODUCTION, and the subdomain is derivable from .github/workflows/
  // lighthouse.yml. If this ever returns true, every scheduled draft is
  // public on that hostname — including /blog/rss.xml, which fires the
  // Buttondown email to real subscribers.
  assert.equal(isPreviewHost(`${WORKER_NAME}.link00seven.workers.dev`), false);
  assert.equal(isPreviewHost(`${WORKER_NAME}.any-other-subdomain.workers.dev`), false);
  assert.equal(isPreviewHost(`${WORKER_NAME.toUpperCase()}.link00seven.WORKERS.DEV`), false);
});

test('lookalike domains are NOT preview hosts', () => {
  // The whole point of anchoring on the leading dot.
  assert.equal(isPreviewHost('evil-workers.dev'), false);
  assert.equal(isPreviewHost('notworkers.dev'), false);
  // ...and a workers.dev-prefixed domain owned by someone else.
  assert.equal(isPreviewHost('workers.dev.attacker.com'), false);
  // The apex serves no Worker, so it is not an unlock either.
  assert.equal(isPreviewHost('workers.dev'), false);
});

test('isPreviewHost is case-insensitive and handles empty input', () => {
  assert.equal(isPreviewHost('ABC.WORKERS.DEV'), true);
  assert.equal(isPreviewHost(''), false);
  assert.equal(isPreviewHost(undefined), false);
  // Trailing-dot FQDN fails closed. Pinned so a future "fix" has to be
  // deliberate rather than incidental.
  assert.equal(isPreviewHost('abc.workers.dev.'), false);
});

// ── sign / verify round trip ─────────────────────────
//
// Every token carries a link id, because every link is recorded in
// preview_links and must therefore be revocable. The id is opaque here — this
// module never touches D1 — but it is inside the signature, so the allowlist
// row a token points at cannot be swapped for another.

const ID = 'aaaa0000bbbb1111';
const OTHER_ID = 'cccc2222dddd3333';

/** Sign the HMAC over an arbitrary payload, for hand-built legacy tokens. */
async function legacyToken(payload) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(KEY), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${payload}.${hex}`;
}

test('newLinkId returns a 16-character lowercase hex id', () => {
  const id = newLinkId();
  assert.match(id, /^[0-9a-f]{16}$/);
  assert.notEqual(newLinkId(), id);
});

test('a freshly signed token verifies and returns its slug', async () => {
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, linkId: ID }, KEY);
  assert.equal(await verifyPreviewToken(token, KEY, NOW), 'my-draft');
});

test('the token carries the slug and link id in readable form', async () => {
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, linkId: ID }, KEY);
  assert.equal(token.split('.').length, 4);
  assert.equal(token.split('.')[0], 'my-draft');
  assert.equal(token.split('.')[1], String(SOON));
  assert.equal(token.split('.')[2], ID);
});

test('a view-only token round-trips to a grant with no reviewer', async () => {
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, linkId: ID }, KEY);
  assert.deepEqual(await verifyPreviewGrant(token, KEY, NOW), {
    slug: 'my-draft',
    reviewer: null,
    linkId: ID,
  });
});

// ── rejection cases ──────────────────────────────────

test('an expired token is rejected', async () => {
  const past = Math.floor(NOW / 1000) - 1;
  const token = await signPreviewToken({ slug: 'my-draft', exp: past, linkId: ID }, KEY);
  assert.equal(await verifyPreviewToken(token, KEY, NOW), null);
});

test('expiry is exclusive at the boundary', async () => {
  const exact = Math.floor(NOW / 1000);
  const token = await signPreviewToken({ slug: 'my-draft', exp: exact, linkId: ID }, KEY);
  // exp === now is expired...
  assert.equal(await verifyPreviewToken(token, KEY, exact * 1000), null);
  // ...one millisecond earlier is still valid.
  assert.equal(await verifyPreviewToken(token, KEY, exact * 1000 - 1), 'my-draft');
});

test('a token signed with a different key is rejected', async () => {
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, linkId: ID }, OTHER_KEY);
  assert.equal(await verifyPreviewToken(token, KEY, NOW), null);
});

test('tampering with the slug invalidates the signature', async () => {
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, linkId: ID }, KEY);
  const [, exp, linkId, sig] = token.split('.');
  assert.equal(await verifyPreviewToken(`other-draft.${exp}.${linkId}.${sig}`, KEY, NOW), null);
});

test('extending the expiry invalidates the signature', async () => {
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, linkId: ID }, KEY);
  const [slug, , linkId, sig] = token.split('.');
  assert.equal(await verifyPreviewToken(`${slug}.${SOON + 86400}.${linkId}.${sig}`, KEY, NOW), null);
});

test('malformed tokens are rejected without throwing', async () => {
  for (const bad of [
    '',
    'my-draft',
    'my-draft.123',
    `my-draft.123.${ID}.abcd.extra.more`, // six fields — neither valid shape
    `my-draft.notanumber.${ID}.abcdef`,
    `My-Draft.123.${ID}.abcdef`,          // uppercase slug
    `../../etc/passwd.123.${ID}.abcd`,    // path traversal in the slug position
    `my-draft.123.${ID}.zzzz`,            // non-hex signature
    `my-draft.123.${ID}.abc`,             // odd-length hex
    'my-draft.123.J.D..abcdef',           // dots smuggled into a field
    `my-draft.123.Reviewer.${ID}.abcd`,   // uppercase reviewer
    'my-draft.123.NOTAHEXID000000.abcd',  // link id in the wrong shape
    `my-draft.123.${ID.slice(0, 8)}.abcd`, // link id too short
  ]) {
    assert.equal(await verifyPreviewToken(bad, KEY, NOW), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('an unset signing key never validates anything', async () => {
  // The production fail-closed guarantee: if PREVIEW_SIGNING_KEY is missing
  // from the worker, no token may unlock a draft.
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, linkId: ID }, KEY);
  assert.equal(await verifyPreviewToken(token, '', NOW), null);
  assert.equal(await verifyPreviewToken(token, null, NOW), null);
  assert.equal(await verifyPreviewToken(token, undefined, NOW), null);
});

test('a missing token yields null', async () => {
  assert.equal(await verifyPreviewToken(null, KEY, NOW), null);
  assert.equal(await verifyPreviewToken(undefined, KEY, NOW), null);
});

test('signPreviewToken refuses invalid input', async () => {
  const ok = { slug: 'my-draft', exp: SOON, linkId: ID };
  await assert.rejects(() => signPreviewToken(ok, ''));
  await assert.rejects(() => signPreviewToken({ ...ok, slug: 'Bad Slug' }, KEY));
  await assert.rejects(() => signPreviewToken({ ...ok, exp: -1 }, KEY));
  await assert.rejects(() => signPreviewToken({ ...ok, reviewer: 'Bad Reviewer' }, KEY));
  await assert.rejects(() => signPreviewToken({ ...ok, reviewer: 'has.dot' }, KEY));
});

// ── link ids: what makes a link revocable ────────────
//
// The id is the handle for the row in preview_links. It is inside the
// signature, so a holder cannot repoint their link at a row they know is still
// active — which is the forgery that would defeat revocation entirely.

test('a link id is mandatory on both shapes', async () => {
  // Not defaulted, deliberately: a token minted without an id would be a grant
  // the allowlist has no row for, and therefore no way to withdraw.
  await assert.rejects(
    () => signPreviewToken({ slug: 'my-draft', exp: SOON }, KEY),
    /link id/,
  );
  await assert.rejects(
    () => signPreviewToken({ slug: 'my-draft', exp: SOON, reviewer: 'jd' }, KEY),
    /link id/,
  );
});

test('a malformed link id is refused at signing time', async () => {
  for (const bad of ['not-hex', 'AAAA0000BBBB1111', ID.slice(0, 8), `${ID}00`, 'has.dot.here']) {
    await assert.rejects(
      () => signPreviewToken({ slug: 'my-draft', exp: SOON, linkId: bad }, KEY),
      /link id/,
      `should refuse ${JSON.stringify(bad)}`,
    );
  }
});

test('editing the link id invalidates a view-only token', async () => {
  // The forgery that matters: swap in an id you know is still active.
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, linkId: ID }, KEY);
  const [slug, exp, , sig] = token.split('.');
  assert.equal(await verifyPreviewGrant(`${slug}.${exp}.${OTHER_ID}.${sig}`, KEY, NOW), null);
});

test('editing the link id invalidates a reviewer token', async () => {
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, reviewer: 'jd', linkId: ID }, KEY);
  const [slug, exp, reviewer, , sig] = token.split('.');
  assert.equal(
    await verifyPreviewGrant(`${slug}.${exp}.${reviewer}.${OTHER_ID}.${sig}`, KEY, NOW),
    null,
  );
});

test('the pre-allowlist view-only token no longer verifies', async () => {
  // Three fields is the old shape. It has no row to revoke, so honouring it
  // would leave a permanent grant outside the allowlist. Built by hand because
  // signPreviewToken can no longer produce it.
  assert.equal(await verifyPreviewGrant(await legacyToken(`my-draft.${SOON}`), KEY, NOW), null);
});

test('the pre-allowlist reviewer token no longer verifies', async () => {
  // Four fields whose third is a reviewer rather than a link id. Rejected on
  // the LINK_ID_RE shape check, not on length.
  assert.equal(await verifyPreviewGrant(await legacyToken(`my-draft.${SOON}.jd`), KEY, NOW), null);
});

// ── galley grants: the reviewer field ────────────────
//
// A token that names a reviewer authorises leaving notes on the post, which is
// strictly more than viewing it. These tests exist to pin that the escalation
// lives inside the signature — if it ever became forgeable from a view-only
// link, anyone handed a read-only preview could write to the galley.

test('a reviewer token carries the reviewer through', async () => {
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, reviewer: 'jd', linkId: ID }, KEY);
  assert.deepEqual(await verifyPreviewGrant(token, KEY, NOW), {
    slug: 'my-draft',
    reviewer: 'jd',
    linkId: ID,
  });
});

test('the reviewer is readable in the token', async () => {
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, reviewer: 'jd', linkId: ID }, KEY);
  assert.equal(token.split('.').length, 5);
  assert.equal(token.split('.')[2], 'jd');
  assert.equal(token.split('.')[3], ID);
});

test('both shapes grant viewing — an editor must be able to read the post', async () => {
  const viewOnly = await signPreviewToken({ slug: 'my-draft', exp: SOON, linkId: ID }, KEY);
  const reviewer = await signPreviewToken({ slug: 'my-draft', exp: SOON, reviewer: 'jd', linkId: ID }, KEY);
  assert.equal(await verifyPreviewToken(viewOnly, KEY, NOW), 'my-draft');
  assert.equal(await verifyPreviewToken(reviewer, KEY, NOW), 'my-draft');
});

test('a reviewer cannot be added to a view-only token', async () => {
  // The escalation attempt: hold a read-only link, splice in a reviewer field.
  // Tests SIGNATURE forgery, not arity — the result is a well-formed five-part
  // token, so the length check alone would let it through.
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, linkId: ID }, KEY);
  const [slug, exp, linkId, sig] = token.split('.');
  assert.equal(await verifyPreviewGrant(`${slug}.${exp}.jd.${linkId}.${sig}`, KEY, NOW), null);
});

test('stripping the reviewer out of a token invalidates it', async () => {
  // The other direction of the same forgery: the signature covers the shape, so
  // a five-part token cannot be re-read as a four-part one. Again well-formed.
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, reviewer: 'jd', linkId: ID }, KEY);
  const [slug, exp, , linkId, sig] = token.split('.');
  assert.equal(await verifyPreviewGrant(`${slug}.${exp}.${linkId}.${sig}`, KEY, NOW), null);
});

test('swapping one reviewer for another invalidates the signature', async () => {
  // Otherwise a note could be attributed to an editor who never wrote it.
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, reviewer: 'jd', linkId: ID }, KEY);
  const [slug, exp, , linkId, sig] = token.split('.');
  assert.equal(await verifyPreviewGrant(`${slug}.${exp}.mr.${linkId}.${sig}`, KEY, NOW), null);
});

test('a reviewer token is still scoped to its own slug', async () => {
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, reviewer: 'jd', linkId: ID }, KEY);
  const grant = await verifyPreviewGrant(token, KEY, NOW);
  assert.equal(grant.slug, 'my-draft');
  // The route compares grant.slug to the post it is rendering; this asserts
  // the value it compares against cannot be edited in the URL.
  const [, exp, reviewer, linkId, sig] = token.split('.');
  assert.equal(
    await verifyPreviewGrant(`other-draft.${exp}.${reviewer}.${linkId}.${sig}`, KEY, NOW),
    null,
  );
});

test('a reviewer token expires like any other', async () => {
  const expired = Math.floor(NOW / 1000) - 1;
  const token = await signPreviewToken({ slug: 'my-draft', exp: expired, reviewer: 'jd', linkId: ID }, KEY);
  assert.equal(await verifyPreviewGrant(token, KEY, NOW), null);
});

test('a reviewer token signed with a different key is rejected', async () => {
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, reviewer: 'jd', linkId: ID }, OTHER_KEY);
  assert.equal(await verifyPreviewGrant(token, KEY, NOW), null);
});

test('an unset signing key rejects reviewer tokens too', async () => {
  const token = await signPreviewToken({ slug: 'my-draft', exp: SOON, reviewer: 'jd', linkId: ID }, KEY);
  assert.equal(await verifyPreviewGrant(token, '', NOW), null);
  assert.equal(await verifyPreviewGrant(token, undefined, NOW), null);
});
