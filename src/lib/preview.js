// Preview unlocks for scheduled posts. Two independent signals, both fail-closed:
//
//   1. isPreviewHost(hostname) — *.workers.dev branch deploys reveal every
//      scheduled post.
//   2. verifyPreviewGrant(token, key) — a signed, expiring link reveals ONE post,
//      on any host. A token that names a reviewer may also leave galley notes.
//
// Every token carries a link id naming its row in preview_links, which is what
// makes it revocable. That lookup lives in preview-links.js: this module stays
// DB-free so one copy runs in the worker, under `node --test`, and in
// scripts/preview-link.mjs — the code that mints links is the code that verifies
// them.
//
// A token unlocks the post's own URL only, never the index, tag pages or RSS.
// The feed triggers Buttondown's email, an irreversible send. See
// docs/PREVIEW-LINKS.md.

/**
 * The only slug shape a token can carry. No `.` (the token is dot-delimited),
 * and lowercase-only so signer and verifier cannot normalise differently.
 */
export const SLUG_RE = /^[a-z0-9-]+$/;
const EXP_RE = /^\d+$/;

/** A link id: 64 random bits as lowercase hex. Dot-free, unguessable, pasteable. */
export const LINK_ID_RE = /^[0-9a-f]{16}$/;

/**
 * Mint a fresh link id. Random, not derived: the signature already binds it to
 * the slug, reviewer and expiry.
 *
 * @returns {string}
 */
export function newLinkId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** MUST match `name` in wrangler.jsonc; smoke asserts it. */
export const WORKER_NAME = 'mjrossi-portfolio-website';

/**
 * Does this hostname belong to a preview deployment?
 *
 * Previews live at `<alias>-<worker-name>.<subdomain>.workers.dev`. Two
 * exclusions are load-bearing:
 *
 *   - `evil-workers.dev` does not match: the suffix is anchored on the dot.
 *   - `<worker-name>.<subdomain>.workers.dev` does not match. That is the
 *     Worker's own production alias, on a hostname anyone can derive from this
 *     repo; matching it would expose every draft, RSS included, with no token.
 *     `workers_dev: false` turns the alias off; this holds even if that drifts.
 *
 * A trailing-dot FQDN returns false. That is fail-closed; leave it.
 *
 * @param {string} hostname
 * @returns {boolean}
 */
export function isPreviewHost(hostname) {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  if (!host.endsWith('.workers.dev')) return false;
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
 * Mint a preview token for one post. Two shapes:
 *
 *   `<slug>.<exp>.<linkId>.<sigHex>`            — view-only
 *   `<slug>.<exp>.<reviewer>.<linkId>.<sigHex>` — view and leave galley notes
 *
 * The signature covers every field before it, so neither shape converts into
 * the other. `exp` is epoch SECONDS and is the link's ceiling; the expiry
 * actually enforced is the row's (see preview-links.js).
 *
 * @param {object} grant
 * @param {string} grant.slug
 * @param {number} grant.exp epoch seconds
 * @param {string} grant.linkId required: a token with no row could never be revoked
 * @param {string | null} [grant.reviewer] label recorded on every note
 * @param {string} key PREVIEW_SIGNING_KEY
 * @returns {Promise<string>}
 */
export async function signPreviewToken({ slug, exp, linkId, reviewer = null }, key) {
  if (!key) throw new Error('signPreviewToken: signing key is required');
  if (!SLUG_RE.test(slug)) throw new Error(`signPreviewToken: invalid slug ${JSON.stringify(slug)}`);
  if (!Number.isInteger(exp) || exp < 0) throw new Error('signPreviewToken: exp must be a non-negative integer');
  if (reviewer !== null && !SLUG_RE.test(reviewer)) {
    throw new Error(`signPreviewToken: invalid reviewer ${JSON.stringify(reviewer)}`);
  }
  if (!LINK_ID_RE.test(linkId ?? '')) {
    throw new Error(
      `signPreviewToken: invalid link id ${JSON.stringify(linkId)} — every preview link ` +
        'must be revocable, so one is required on both shapes. See newLinkId().',
    );
  }
  const payload = reviewer === null
    ? `${slug}.${exp}.${linkId}`
    : `${slug}.${exp}.${reviewer}.${linkId}`;
  const sig = await crypto.subtle.sign('HMAC', await importKey(key), new TextEncoder().encode(payload));
  return `${payload}.${toHex(sig)}`;
}

/**
 * Verify a preview token and return what it authorises, or null. Never throws.
 *
 * The signature is checked before expiry, so a tampered `exp` fails as a bad
 * signature. `crypto.subtle.verify` compares in constant time. A reviewer is
 * carried inside the signature, so a view-only link cannot be promoted by
 * editing the URL.
 *
 * Does NOT consult the allowlist; middleware requires an active row for the
 * returned `linkId` before honouring the grant.
 *
 * @param {string | null | undefined} token
 * @param {string | null | undefined} key absent ⇒ always null
 * @param {number} [now] epoch ms
 * @returns {Promise<{ slug: string, reviewer: string | null, linkId: string } | null>}
 */
export async function verifyPreviewGrant(token, key, now = Date.now()) {
  if (!token || !key) return null;

  const parts = token.split('.');
  // Pre-allowlist tokens (no link id) are refused: three fields fails here, and
  // the old four-field reviewer shape fails LINK_ID_RE below.
  if (parts.length !== 4 && parts.length !== 5) return null;

  const slug = parts[0];
  const exp = parts[1];
  const reviewer = parts.length === 5 ? parts[2] : null;
  const linkId = parts.length === 5 ? parts[3] : parts[2];
  const sigHex = parts[parts.length - 1];

  if (!SLUG_RE.test(slug) || !EXP_RE.test(exp)) return null;
  if (reviewer !== null && !SLUG_RE.test(reviewer)) return null;
  if (!LINK_ID_RE.test(linkId)) return null;

  const sig = fromHex(sigHex);
  if (!sig) return null;

  const payload = parts.slice(0, -1).join('.');

  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      'HMAC',
      await importKey(key),
      sig,
      new TextEncoder().encode(payload),
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  // Exclusive: a token whose exp is exactly now has expired.
  if (Number(exp) * 1000 <= now) return null;

  return { slug, reviewer, linkId };
}

/**
 * The viewing half of verifyPreviewGrant: the authorised slug, or null. Both
 * token shapes grant viewing.
 *
 * @param {string | null | undefined} token
 * @param {string | null | undefined} key
 * @param {number} [now] epoch ms
 * @returns {Promise<string | null>}
 */
export async function verifyPreviewToken(token, key, now = Date.now()) {
  const grant = await verifyPreviewGrant(token, key, now);
  return grant === null ? null : grant.slug;
}
