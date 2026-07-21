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
import { isPreviewHost, signPreviewToken, verifyPreviewToken, WORKER_NAME } from './preview.js';

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
  // Buttondown email and the LinkedIn/Bluesky fan-out.
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

test('a freshly signed token verifies and returns its slug', async () => {
  const token = await signPreviewToken('my-draft', SOON, KEY);
  assert.equal(await verifyPreviewToken(token, KEY, NOW), 'my-draft');
});

test('the token carries the slug in readable form', async () => {
  const token = await signPreviewToken('my-draft', SOON, KEY);
  assert.equal(token.split('.').length, 3);
  assert.equal(token.split('.')[0], 'my-draft');
  assert.equal(token.split('.')[1], String(SOON));
});

// ── rejection cases ──────────────────────────────────

test('an expired token is rejected', async () => {
  const past = Math.floor(NOW / 1000) - 1;
  const token = await signPreviewToken('my-draft', past, KEY);
  assert.equal(await verifyPreviewToken(token, KEY, NOW), null);
});

test('expiry is exclusive at the boundary', async () => {
  const exact = Math.floor(NOW / 1000);
  const token = await signPreviewToken('my-draft', exact, KEY);
  // exp === now is expired...
  assert.equal(await verifyPreviewToken(token, KEY, exact * 1000), null);
  // ...one millisecond earlier is still valid.
  assert.equal(await verifyPreviewToken(token, KEY, exact * 1000 - 1), 'my-draft');
});

test('a token signed with a different key is rejected', async () => {
  const token = await signPreviewToken('my-draft', SOON, OTHER_KEY);
  assert.equal(await verifyPreviewToken(token, KEY, NOW), null);
});

test('tampering with the slug invalidates the signature', async () => {
  const token = await signPreviewToken('my-draft', SOON, KEY);
  const [, exp, sig] = token.split('.');
  assert.equal(await verifyPreviewToken(`other-draft.${exp}.${sig}`, KEY, NOW), null);
});

test('extending the expiry invalidates the signature', async () => {
  const token = await signPreviewToken('my-draft', SOON, KEY);
  const [slug, , sig] = token.split('.');
  assert.equal(await verifyPreviewToken(`${slug}.${SOON + 86400}.${sig}`, KEY, NOW), null);
});

test('malformed tokens are rejected without throwing', async () => {
  for (const bad of [
    '',
    'my-draft',
    'my-draft.123',
    'my-draft.123.abc.extra',
    'my-draft.notanumber.abcdef',
    'My-Draft.123.abcdef',       // uppercase slug
    '../../etc/passwd.123.abcd', // path traversal in the slug position
    'my-draft.123.zzzz',         // non-hex signature
    'my-draft.123.abc',          // odd-length hex
  ]) {
    assert.equal(await verifyPreviewToken(bad, KEY, NOW), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('an unset signing key never validates anything', async () => {
  // The production fail-closed guarantee: if PREVIEW_SIGNING_KEY is missing
  // from the worker, no token may unlock a draft.
  const token = await signPreviewToken('my-draft', SOON, KEY);
  assert.equal(await verifyPreviewToken(token, '', NOW), null);
  assert.equal(await verifyPreviewToken(token, null, NOW), null);
  assert.equal(await verifyPreviewToken(token, undefined, NOW), null);
});

test('a missing token yields null', async () => {
  assert.equal(await verifyPreviewToken(null, KEY, NOW), null);
  assert.equal(await verifyPreviewToken(undefined, KEY, NOW), null);
});

test('signPreviewToken refuses invalid input', async () => {
  await assert.rejects(() => signPreviewToken('my-draft', SOON, ''));
  await assert.rejects(() => signPreviewToken('Bad Slug', SOON, KEY));
  await assert.rejects(() => signPreviewToken('my-draft', -1, KEY));
});
