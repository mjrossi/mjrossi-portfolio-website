import test from 'node:test';
import assert from 'node:assert/strict';
import { certsUrl, issuerFor, resetJwksCache, verifyAccessJwt } from './access.js';

// The gate on /admin. See access.js for why the worker verifies a token the edge
// has already checked, and why `aud` is the check that matters most.

const TEAM = 'example.cloudflareaccess.com';
const AUD = 'a'.repeat(64);
const OTHER_AUD = 'b'.repeat(64);
const NOW = Date.UTC(2026, 4, 10, 12, 0, 0);
const NOW_SEC = Math.floor(NOW / 1000);

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeSegment = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

/** One RSA keypair, generated once and shared by every test below. */
const keyPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);
const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
const JWKS = { keys: [{ ...publicJwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] };

/** A second keypair, for "signed by something else entirely". */
const otherPair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['sign', 'verify'],
);

async function mint(payloadOver = {}, { header: headerOver = {}, signWith = keyPair.privateKey } = {}) {
  const header = encodeSegment({ alg: 'RS256', kid: 'test-key', typ: 'JWT', ...headerOver });
  const payload = encodeSegment({
    aud: [AUD],
    iss: issuerFor(TEAM),
    email: 'operator@example.com',
    sub: 'user-1',
    exp: NOW_SEC + 3600,
    iat: NOW_SEC - 60,
    ...payloadOver,
  });
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    signWith,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

const verify = (token, over = {}) =>
  verifyAccessJwt(token, { teamDomain: TEAM, aud: AUD, jwksOverride: JWKS, now: NOW, ...over });

// ── the happy path ───────────────────────────────────

test('a well-formed token verifies and names the operator', async () => {
  const grant = await verify(await mint());
  assert.deepEqual(grant, { email: 'operator@example.com', sub: 'user-1' });
});

test('aud may be a bare string as well as an array', async () => {
  assert.notEqual(await verify(await mint({ aud: AUD })), null);
});

test('a token with several audiences passes if ours is among them', async () => {
  assert.notEqual(await verify(await mint({ aud: [OTHER_AUD, AUD] })), null);
});

test('a missing email is reported as null rather than refused', async () => {
  // Service tokens carry no email. They are still valid principals.
  const grant = await verify(await mint({ email: undefined }));
  assert.deepEqual(grant, { email: null, sub: 'user-1' });
});

// ── the audience, which is the whole point ───────────

test('a token for ANOTHER Access app on the same team is refused', async () => {
  // The check this module exists for. Access signs per TEAM, so a token from the
  // preview-URL app verifies its signature perfectly and must still be denied.
  assert.equal(await verify(await mint({ aud: [OTHER_AUD] })), null);
});

test('a missing aud claim is refused', async () => {
  assert.equal(await verify(await mint({ aud: undefined })), null);
});

test('an aud that is neither string nor array is refused', async () => {
  assert.equal(await verify(await mint({ aud: { tag: AUD } })), null);
});

// ── signature and algorithm ──────────────────────────

test('a token signed by a different key is refused', async () => {
  assert.equal(await verify(await mint({}, { signWith: otherPair.privateKey })), null);
});

test('a tampered payload is refused', async () => {
  const token = await mint();
  const [header, , signature] = token.split('.');
  const swapped = encodeSegment({ aud: [AUD], iss: issuerFor(TEAM), exp: NOW_SEC + 99999 });
  assert.equal(await verify(`${header}.${swapped}.${signature}`), null);
});

test('alg: none is refused', async () => {
  // The classic break. alg is attacker-controlled, so it is pinned rather than
  // honoured.
  const header = encodeSegment({ alg: 'none', kid: 'test-key' });
  const payload = encodeSegment({ aud: [AUD], iss: issuerFor(TEAM), exp: NOW_SEC + 3600 });
  assert.equal(await verify(`${header}.${payload}.`), null);
});

test('an HMAC alg is refused rather than verified against the public key', async () => {
  // The other half of the same break: the RSA public key is published at the
  // certs URL, so treating it as an HMAC secret makes it forgeable by anyone.
  assert.equal(await verify(await mint({}, { header: { alg: 'HS256' } })), null);
});

test('an unknown kid is refused without refetching', async () => {
  assert.equal(await verify(await mint({}, { header: { kid: 'not-a-key' } })), null);
});

test('a key set containing a malformed entry still verifies against a good one', async () => {
  // During rotation there are several keys and only one has to work.
  const withJunk = { keys: [{ kid: 'test-key', kty: 'RSA', n: '!!!', e: 'AQAB' }, ...JWKS.keys] };
  assert.notEqual(await verify(await mint({}, { header: { kid: undefined } }), { jwksOverride: withJunk }), null);
});

// ── the remaining claims ─────────────────────────────

test('a token from another team is refused', async () => {
  assert.equal(await verify(await mint({ iss: 'https://evil.cloudflareaccess.com' })), null);
});

test('an expired token is refused, and expiry is exclusive', async () => {
  assert.equal(await verify(await mint({ exp: NOW_SEC })), null);
  assert.notEqual(await verify(await mint({ exp: NOW_SEC + 1 })), null);
});

test('a missing or non-numeric exp is refused', async () => {
  assert.equal(await verify(await mint({ exp: undefined })), null);
  assert.equal(await verify(await mint({ exp: 'soon' })), null);
});

test('a not-yet-valid token is refused', async () => {
  assert.equal(await verify(await mint({ nbf: NOW_SEC + 60 })), null);
  assert.notEqual(await verify(await mint({ nbf: NOW_SEC })), null);
});

// ── malformed input and missing configuration ────────

test('missing, empty and malformed tokens are all refused', async () => {
  for (const bad of [null, undefined, '', 'not-a-jwt', 'a.b', 'a.b.c.d', '...']) {
    assert.equal(await verify(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
});

test('segments that are not base64 or not JSON are refused', async () => {
  assert.equal(await verify('%%%.%%%.%%%'), null);
  assert.equal(await verify(`${b64url(new TextEncoder().encode('nope'))}.a.b`), null);
});

test('an unconfigured gate denies everything', async () => {
  // A deploy that forgot the vars makes the Desk unreachable, never public.
  const token = await mint();
  assert.equal(await verify(token, { teamDomain: null }), null);
  assert.equal(await verify(token, { aud: null }), null);
  assert.equal(await verify(token, { teamDomain: null, aud: null }), null);
});

test('an empty or unparseable key set denies everything', async () => {
  const token = await mint();
  assert.equal(await verify(token, { jwksOverride: { keys: [] } }), null);
  assert.equal(await verify(token, { jwksOverride: '{ not json' }), null);
  assert.equal(await verify(token, { jwksOverride: '{"keys":"nope"}' }), null);
});

// ── the fetch path ───────────────────────────────────

test('the certs URL is built from the team domain', () => {
  assert.equal(certsUrl(TEAM), 'https://example.cloudflareaccess.com/cdn-cgi/access/certs');
});

test('keys are fetched when no override is given, and cached within the isolate', async () => {
  resetJwksCache();
  let calls = 0;
  const fetchImpl = async (url) => {
    calls++;
    assert.equal(url, certsUrl(TEAM));
    return { ok: true, json: async () => JWKS };
  };
  const token = await mint();
  assert.notEqual(await verify(token, { jwksOverride: null, fetchImpl }), null);
  assert.notEqual(await verify(token, { jwksOverride: null, fetchImpl }), null);
  assert.equal(calls, 1, 'the key set was refetched inside the TTL');
});

test('a cached key set is refreshed once the TTL has passed', async () => {
  resetJwksCache();
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return { ok: true, json: async () => JWKS };
  };
  const token = await mint();
  await verify(token, { jwksOverride: null, fetchImpl });
  await verify(token, { jwksOverride: null, fetchImpl, now: NOW + 61 * 60 * 1000 });
  assert.equal(calls, 2);
});

test('a certs endpoint that fails is a denial, and is not cached', async () => {
  resetJwksCache();
  let calls = 0;
  const failing = async () => {
    calls++;
    return { ok: false, status: 503, json: async () => ({}) };
  };
  const token = await mint();
  assert.equal(await verify(token, { jwksOverride: null, fetchImpl: failing }), null);
  assert.equal(await verify(token, { jwksOverride: null, fetchImpl: failing }), null);
  // Caching the failure would turn one bad minute upstream into an hour of a
  // locked-out Desk.
  assert.equal(calls, 2);
});

test('a certs endpoint that throws is a denial rather than a 500', async () => {
  resetJwksCache();
  const throwing = async () => {
    throw new Error('network down');
  };
  assert.equal(await verify(await mint(), { jwksOverride: null, fetchImpl: throwing }), null);
});
