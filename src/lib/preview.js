// Preview unlocks for scheduled posts. Two independent signals, both
// fail-closed:
//
//   1. isPreviewHost(hostname) — requests to *.workers.dev (Cloudflare
//      Workers Builds PR-branch deploys) reveal every scheduled post.
//   2. verifyPreviewToken(token, key) — a signed, expiring link reveals
//      exactly ONE post, on any host including production.
//
// Plain JS for the same reason as schedule.js and csp.js: `node --test`
// imports it directly, no TypeScript tooling on the test side. It uses
// globalThis.crypto.subtle, which exists in both the Cloudflare Worker and
// Node 22 — so this single module also backs scripts/preview-link.mjs, and
// the code that mints links is literally the code that verifies them.
//
// Scope note: a signed token unlocks the post's own URL only. It is
// deliberately NOT plumbed into the blog index, tag pages, or the RSS feed —
// RSS drives Buttondown's email + social syndication, and a preview link must
// never be able to reach it. See CLAUDE.md, "Scheduled publishing".

/**
 * The only slug shape a preview token can carry. Deliberately narrow: the slug
 * is concatenated into a dot-delimited token, so anything containing a `.`
 * would break parsing, and restricting to lowercase alphanumerics + dashes
 * removes any question of case- or unicode-normalisation mismatch between the
 * signing and verifying sides.
 *
 * Exported so scripts/preview-link.mjs can reject an unsupported slug with a
 * useful message instead of letting signPreviewToken throw a raw stack trace.
 */
export const SLUG_RE = /^[a-z0-9-]+$/;
const EXP_RE = /^\d+$/;

/**
 * The deployed Worker's name. MUST match `name` in wrangler.jsonc — that
 * pairing is what distinguishes the production workers.dev alias from a
 * preview one, so scripts/smoke.mjs asserts the two stay in sync.
 */
export const WORKER_NAME = 'mjrossi-portfolio-website';

/**
 * Does this hostname belong to a preview deployment?
 *
 * Cloudflare Workers Builds puts branch/version deploys on
 * `<alias>-<worker-name>.<subdomain>.workers.dev`; production is mjrossi.com.
 * This is an allowlist, not a denylist — an unrecognised host hides
 * scheduled posts, so a misconfiguration fails toward "hidden".
 *
 * Two exclusions, both load-bearing:
 *
 *   - `evil-workers.dev` does not match: the suffix check is anchored on the
 *     leading dot.
 *   - `<worker-name>.<subdomain>.workers.dev` does not match. That is the
 *     Worker's OWN production alias, which Cloudflare enables by default and
 *     which serves the live site on a hostname anyone can derive from this
 *     repo. Matching it would expose every scheduled draft — RSS included —
 *     with no token at all, which is the exact leak the signed-link scoping
 *     exists to prevent. wrangler.jsonc also sets `"workers_dev": false` to
 *     turn that alias off; this check is the belt to that config's braces,
 *     because it holds even if the account state drifts.
 *
 * A trailing-dot FQDN (`x.workers.dev.`) returns false. That is fail-closed
 * (drafts stay hidden), so it is left alone deliberately — do not "fix" it
 * into an open state.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPreviewHost(hostname) {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  if (!host.endsWith('.workers.dev')) return false;
  // Production is exactly `<worker-name>.<subdomain>.workers.dev`; every
  // preview prefixes the worker name with a branch or version alias.
  return host.split('.')[0] !== WORKER_NAME;
}

/** @param {string} key */
async function importKey(key) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

/** @param {ArrayBuffer} buf */
function toHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** @param {string} hex */
function fromHex(hex) {
  if (hex.length === 0 || hex.length % 2 !== 0 || !/^[0-9a-f]+$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/**
 * Mint a preview token for one post. Used by scripts/preview-link.mjs.
 *
 * Token shape: `<slug>.<exp>.<sigHex>`, where the signed payload is
 * `<slug>.<exp>` and `exp` is epoch SECONDS (shorter and more scannable in a
 * URL than milliseconds).
 *
 * @param {string} slug post id, e.g. 'why-im-pivoting'
 * @param {number} exp expiry as epoch seconds
 * @param {string} key signing key (PREVIEW_SIGNING_KEY)
 * @returns {Promise<string>}
 */
export async function signPreviewToken(slug, exp, key) {
  if (!key) throw new Error('signPreviewToken: signing key is required');
  if (!SLUG_RE.test(slug)) throw new Error(`signPreviewToken: invalid slug ${JSON.stringify(slug)}`);
  if (!Number.isInteger(exp) || exp < 0) throw new Error('signPreviewToken: exp must be a non-negative integer');
  const payload = `${slug}.${exp}`;
  const sig = await crypto.subtle.sign('HMAC', await importKey(key), new TextEncoder().encode(payload));
  return `${payload}.${toHex(sig)}`;
}

/**
 * Verify a preview token and return the slug it authorises, or null.
 *
 * Never throws — every malformed, unsigned, tampered, or expired input is a
 * plain `null` so the caller can treat "no token" and "bad token" the same
 * way (both mean: serve the normal 404).
 *
 * Signature is checked BEFORE expiry, so a tampered `exp` is rejected as a
 * bad signature rather than leaking whether some other expiry would validate.
 * crypto.subtle.verify does the comparison in constant time, which is why
 * there is no hand-rolled equality check anywhere in here.
 *
 * @param {string | null | undefined} token
 * @param {string | null | undefined} key signing key; absent ⇒ always null
 * @param {number} [now] epoch ms; defaults to the current time
 * @returns {Promise<string | null>} the authorised slug, or null
 */
export async function verifyPreviewToken(token, key, now = Date.now()) {
  if (!token || !key) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [slug, exp, sigHex] = parts;
  if (!SLUG_RE.test(slug) || !EXP_RE.test(exp)) return null;

  const sig = fromHex(sigHex);
  if (!sig) return null;

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await importKey(key),
      sig,
      new TextEncoder().encode(`${slug}.${exp}`),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  // Expiry is exclusive: a token whose exp is exactly now has expired.
  if (Number(exp) * 1000 <= now) return null;

  return slug;
}
