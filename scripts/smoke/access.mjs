// The Cloudflare Access harness: a throwaway keypair, the JWKS the worker will
// trust for the length of one run, and a minter for the tokens the Desk checks
// assert with.
//
// There is no Access in front of `wrangler dev`, so without this the only thing
// smoke could assert about /admin is that it 404s — which is satisfied just as
// well by the Desk not existing. The positive path is what proves the gate is
// wired to the routes rather than merely correct in isolation, and it is the
// same gap the preview-host matrix exists to close for isPreviewHost.
//
// The worker trusts this key set through ACCESS_JWKS_OVERRIDE, which replaces
// the fetch to Cloudflare's certs endpoint. That has to be an override rather
// than a local certs server because wrangler.jsonc sets
// `global_fetch_strictly_public`, and the worker will not fetch a loopback
// address at all.
//
// The private key never leaves this process and the keypair is regenerated every
// run, so nothing here is a credential — but the SHAPE is the real one: a real
// RS256 signature over a real JWT, verified by the same src/lib/access.js the
// deployed worker runs.

import { readDevVar } from '../dev-vars.mjs';

/** The team the fixture tokens claim to come from. */
export const ACCESS_TEAM_DOMAIN = 'smoke.cloudflareaccess.com';
/** The AUD tag of the fixture "application" — what the worker is told to require. */
export const ACCESS_AUD = 'smoke-desk-application-audience-tag';
/**
 * A DIFFERENT application's AUD, on the same team.
 *
 * This is the case the whole gate turns on. Access signs per team, so a token
 * from another app on the account verifies its signature perfectly — this
 * account really does have a second app, the one covering preview-URL
 * hostnames, whose policy is the looser of the two by design. A token minted
 * with this audience must still be refused.
 */
export const OTHER_AUD = 'smoke-some-other-application-audience-tag';

const b64url = (bytes) =>
  Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const segment = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

const keyPair = await globalThis.crypto.subtle.generateKey(
  {
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  },
  true,
  ['sign', 'verify'],
);

const publicJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.publicKey);
const JWKS = JSON.stringify({
  keys: [{ ...publicJwk, kid: 'smoke-access-key', alg: 'RS256', use: 'sig' }],
});

/**
 * Mint a token for the fixture Access application.
 *
 * @param {{ aud?: string, expiresInSec?: number, email?: string }} [over]
 */
export async function mintAccessJwt({
  aud = ACCESS_AUD,
  expiresInSec = 3600,
  email = 'smoke@example.com',
} = {}) {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = segment({ alg: 'RS256', kid: 'smoke-access-key', typ: 'JWT' });
  const payload = segment({
    aud: [aud],
    iss: `https://${ACCESS_TEAM_DOMAIN}`,
    email,
    sub: 'smoke-user',
    iat: nowSec - 60,
    exp: nowSec + expiresInSec,
  });
  const signature = await globalThis.crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`),
  );
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

/** The header Cloudflare Access sets, as the checks send it. */
export const accessHeader = (token) => ({ 'Cf-Access-Jwt-Assertion': token });

/**
 * `.dev.vars` beats `--var` in wrangler dev, so a developer who has set any of
 * these by hand would silently run the Desk checks against a worker configured
 * for a different key entirely: every positive assertion fails locally while CI,
 * which has no .dev.vars, passes. That is the worst kind of flake, and it is the
 * same precedence trap documented for PREVIEW_SIGNING_KEY in config.mjs — except
 * that there smoke can adopt the developer's key, and here it cannot, because
 * the matching PRIVATE key is not in the file.
 *
 * So it is detected and reported rather than worked around.
 *
 * @returns {string[]} names set in .dev.vars that would shadow this harness
 */
export function conflictingDevVars() {
  return ['ACCESS_JWKS_OVERRIDE', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'].filter((name) =>
    Boolean(readDevVar(name)),
  );
}

/** What to hand `wrangler dev` so the worker trusts the key set above. */
export const ACCESS_ARGS = [
  '--var',
  `ACCESS_TEAM_DOMAIN:${ACCESS_TEAM_DOMAIN}`,
  '--var',
  `ACCESS_AUD:${ACCESS_AUD}`,
  '--var',
  `ACCESS_JWKS_OVERRIDE:${JWKS}`,
];
