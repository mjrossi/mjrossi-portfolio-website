// Cloudflare Access JWT verification — the gate on /admin, the Desk.
//
// WHY THE WORKER CHECKS AT ALL. Access runs at the edge and an unauthenticated
// request to a protected path never reaches this code, so on the happy path this
// module is redundant. It exists for the same reason wrangler.jsonc sets
// `workers_dev: false` AND src/lib/preview.js separately excludes the production
// alias: one misconfigured route, one hostname that bypasses the Access app, and
// the edge gate is simply not in the path any more. The Desk is the first
// unscoped surface in this repo — every draft, every reviewer label, every note
// at once, where a preview link grants exactly one post — so it does not get to
// rest on a dashboard setting no test can see.
//
// THE `aud` CHECK IS THE LOAD-BEARING ONE. A Cloudflare Access JWT is signed by
// the TEAM, not by the application, so every app on the account shares a signing
// key and a valid token from any of them verifies here. This account already has
// a second app — the one covering preview-URL hostnames, whose policy is the
// looser of the two by design. Without comparing `aud` against this app's own
// tag, a token minted for that app opens the Desk. Signature-valid and entirely
// wrong, which is the same shape as the cross-slug preview token that a
// signature check alone cannot catch.
//
// FAILS CLOSED ON EVERY PATH: no token, malformed token, unknown key, bad
// signature, wrong audience, wrong issuer, expired, not-yet-valid, missing
// config, a JWKS that will not fetch or will not parse. There is deliberately no
// branch here where a failure widens access — the worst outcome of a Cloudflare
// outage is that the Desk is unreachable from a browser, which is recoverable
// and immediately visible, whereas the worst outcome of failing open is the
// whole draft inventory served to anyone who finds the path.
//
// Plain JS, like preview.js, so `node --test` reaches it without TypeScript
// tooling and one module serves the worker and the tests alike.

/** Where Access publishes a team's signing keys. */
export function certsUrl(teamDomain) {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

/** The `iss` every token from a team carries. */
export function issuerFor(teamDomain) {
  return `https://${teamDomain}`;
}

/**
 * How long a fetched key set is reused within one isolate.
 *
 * Cloudflare rotates Access signing keys with an overlap window and publishes
 * both keys for its duration, so a cache shorter than that window buys nothing
 * and a cache longer than it would outlive the old key. An hour sits well inside
 * the overlap.
 *
 * Deliberately NOT paired with a "refetch when the kid is unknown" path, which
 * is the obvious next idea and is a request amplifier: an attacker sending
 * tokens with random `kid` values would drive one upstream fetch each. An
 * unknown kid fails closed and the next TTL expiry picks up the new key.
 */
const JWKS_TTL_MS = 60 * 60 * 1000;

/** teamDomain → { at, keys }, per isolate. */
const jwksCache = new Map();

function base64UrlToBytes(input) {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonSegment(segment) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(segment)));
}

/**
 * The team's current signing keys.
 *
 * `jwksOverride` short-circuits the fetch and is how this runs under
 * `wrangler dev` and in smoke. It has to be an override rather than a local
 * JWKS server because wrangler.jsonc sets the `global_fetch_strictly_public`
 * compatibility flag, which makes the worker refuse to fetch a loopback address
 * at all — so there is no local URL this could be pointed at.
 *
 * THE OVERRIDE REPLACES THE TRUST ROOT, so it is read only from .dev.vars, which
 * is gitignored and never deployed. Nothing in CI can prove it is unset in
 * production; if the gate ever misbehaves, check this first.
 *
 * A failed fetch is not cached. Caching it would turn one bad minute upstream
 * into an hour of a locked-out Desk.
 */
async function loadKeys(teamDomain, jwksOverride, fetchImpl, now) {
  if (jwksOverride) {
    const parsed = typeof jwksOverride === 'string' ? JSON.parse(jwksOverride) : jwksOverride;
    return Array.isArray(parsed?.keys) ? parsed.keys : [];
  }
  const cached = jwksCache.get(teamDomain);
  if (cached && now - cached.at < JWKS_TTL_MS) return cached.keys;

  const response = await fetchImpl(certsUrl(teamDomain));
  if (!response.ok) throw new Error(`access: certs endpoint returned ${response.status}`);
  const body = await response.json();
  const keys = Array.isArray(body?.keys) ? body.keys : [];
  jwksCache.set(teamDomain, { at: now, keys });
  return keys;
}

/** Test seam: drop the per-isolate key cache. */
export function resetJwksCache() {
  jwksCache.clear();
}

/**
 * Verify an Access JWT and return who it names.
 *
 * @param {string | null | undefined} token the Cf-Access-Jwt-Assertion header,
 *   or the CF_Authorization cookie — they carry the same JWT.
 * @param {{ teamDomain?: string | null, aud?: string | null,
 *           jwksOverride?: string | object | null, now?: number,
 *           fetchImpl?: typeof fetch }} config
 * @returns {Promise<{ email: string | null, sub: string | null } | null>}
 *   null means denied, for every reason. The caller must not distinguish them.
 */
export async function verifyAccessJwt(token, config = {}) {
  const {
    teamDomain = null,
    aud = null,
    jwksOverride = null,
    now = Date.now(),
    fetchImpl = globalThis.fetch,
  } = config;

  // Unconfigured is denied, not open. A deploy that forgot the vars should make
  // the Desk unreachable rather than public.
  if (!token || !teamDomain || !aud) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [rawHeader, rawPayload, rawSignature] = parts;

    const header = decodeJsonSegment(rawHeader);
    // Pinned rather than read from the token. `alg` is attacker-controlled, and
    // honouring whatever it says is the classic JWT break — "none" verifies
    // everything, and an HMAC alg would have the RSA public key used as a shared
    // secret, which is published at the certs URL above.
    if (header?.alg !== 'RS256') return null;

    const keys = await loadKeys(teamDomain, jwksOverride, fetchImpl, now);
    // `kid` narrows to one key when present; without it every key is tried,
    // which is correct and merely slower. Either way a signature has to verify.
    const candidates = header.kid ? keys.filter((key) => key.kid === header.kid) : keys;
    if (candidates.length === 0) return null;

    const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
    const signature = base64UrlToBytes(rawSignature);

    let verified = false;
    for (const jwk of candidates) {
      let key;
      try {
        key = await globalThis.crypto.subtle.importKey(
          'jwk',
          { ...jwk, alg: 'RS256', ext: true, key_ops: ['verify'] },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify'],
        );
      } catch {
        // A malformed entry in the key set must not take the others down with
        // it — during rotation there are several, and only one has to work.
        continue;
      }
      if (await globalThis.crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed)) {
        verified = true;
        break;
      }
    }
    if (!verified) return null;

    // Claims are checked only AFTER the signature, so nothing in an unsigned
    // payload can influence the decision — same ordering as verifyPreviewGrant.
    const payload = decodeJsonSegment(rawPayload);

    // The audience. See this file's header: without it, any Access app on the
    // team opens the Desk.
    const claimed = payload?.aud;
    const audienceOk = Array.isArray(claimed) ? claimed.includes(aud) : claimed === aud;
    if (!audienceOk) return null;

    if (payload?.iss !== issuerFor(teamDomain)) return null;

    // Seconds, per RFC 7519. Expiry is exclusive, matching how this repo treats
    // every other expiry (isLinkActive, verifyPreviewGrant): at exactly `exp`
    // the token is spent.
    const nowSec = Math.floor(now / 1000);
    if (!Number.isFinite(payload?.exp) || payload.exp <= nowSec) return null;
    // `nbf` is optional; when present a token used early is refused.
    if (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf > nowSec)) {
      return null;
    }

    return {
      email: typeof payload.email === 'string' ? payload.email : null,
      sub: typeof payload.sub === 'string' ? payload.sub : null,
    };
  } catch {
    // Malformed base64, malformed JSON, an unreachable certs endpoint, a
    // subtle-crypto refusal. All of them are denials.
    return null;
  }
}
