// Cloudflare Access JWT verification — the worker's own gate on /admin.
//
// Access already blocks the path at the edge; this is the second check, for the
// day a route or hostname misses the Access app. The Desk lists every draft and
// note at once, so it does not rest on a dashboard setting no test can see.
//
// `aud` IS THE LOAD-BEARING CLAIM. Access signs per TEAM, not per app, so a
// token from any app on the account verifies here — including the looser one
// covering preview hostnames. Only the audience tells them apart.
//
// Fails closed on every path, including missing config and an unreachable
// JWKS. The worst case is a Desk nobody can open, which is visible and
// recoverable.

/** Where Access publishes a team's signing keys. */
export function certsUrl(teamDomain) {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

/** The `iss` every token from a team carries. */
export function issuerFor(teamDomain) {
  return `https://${teamDomain}`;
}

/**
 * How long a fetched key set is reused per isolate. Well inside Access's key
 * rotation overlap.
 *
 * No "refetch on unknown kid": random kids would turn that into one upstream
 * fetch per request. An unknown kid fails closed until the TTL expires.
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
 * `jwksOverride` replaces the fetch under `wrangler dev` and smoke, where
 * `global_fetch_strictly_public` forbids a loopback JWKS server. It REPLACES THE
 * TRUST ROOT, so it is read only from .dev.vars; smoke asserts wrangler.jsonc
 * never declares it. A `wrangler secret put` of the same name is invisible to
 * the repo — if the gate misbehaves, check that first.
 *
 * Failures are not cached, and neither is an empty key set even on a 200:
 * either would lock the Desk for a full TTL on one bad response.
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
  if (keys.length > 0) jwksCache.set(teamDomain, { at: now, keys });
  return keys;
}

/** Test seam: drop the per-isolate key cache. */
export function resetJwksCache() {
  jwksCache.clear();
}

/**
 * Verify an Access JWT and return who it names.
 *
 * @param {string | null | undefined} token the Cf-Access-Jwt-Assertion header
 * @param {{ teamDomain?: string | null, aud?: string | null,
 *           jwksOverride?: string | object | null, now?: number,
 *           fetchImpl?: typeof fetch }} config
 * @returns {Promise<{ email: string | null, sub: string | null } | null>}
 *   null means denied, for every reason; callers must not distinguish them.
 */
export async function verifyAccessJwt(token, config = {}) {
  const {
    teamDomain = null,
    aud = null,
    jwksOverride = null,
    now = Date.now(),
    fetchImpl = globalThis.fetch,
  } = config;

  // Unconfigured is denied, not open.
  if (!token || !teamDomain || !aud) return null;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [rawHeader, rawPayload, rawSignature] = parts;

    const header = decodeJsonSegment(rawHeader);
    // Pinned, never read from the token: honouring `alg` is the classic JWT
    // break ("none", or HMAC keyed with the published RSA public key).
    if (header?.alg !== 'RS256') return null;

    const keys = await loadKeys(teamDomain, jwksOverride, fetchImpl, now);
    // Without a `kid`, every key is tried.
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
        // One malformed key must not take down the others during rotation.
        continue;
      }
      if (await globalThis.crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed)) {
        verified = true;
        break;
      }
    }
    if (!verified) return null;

    // Claims only after the signature, so nothing unsigned influences the result.
    const payload = decodeJsonSegment(rawPayload);

    // See the header: without this, any Access app on the team opens the Desk.
    const claimed = payload?.aud;
    const audienceOk = Array.isArray(claimed) ? claimed.includes(aud) : claimed === aud;
    if (!audienceOk) return null;

    if (payload?.iss !== issuerFor(teamDomain)) return null;

    // Seconds, per RFC 7519. Exclusive, like every other expiry here.
    const nowSec = Math.floor(now / 1000);
    if (!Number.isFinite(payload?.exp) || payload.exp <= nowSec) return null;
    if (payload.nbf !== undefined && (!Number.isFinite(payload.nbf) || payload.nbf > nowSec)) {
      return null;
    }

    return {
      email: typeof payload.email === 'string' ? payload.email : null,
      sub: typeof payload.sub === 'string' ? payload.sub : null,
    };
  } catch {
    // Malformed input, an unreachable certs endpoint, a crypto refusal: all denials.
    return null;
  }
}
