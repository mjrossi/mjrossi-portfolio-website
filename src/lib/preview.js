// Preview unlocks for scheduled posts. Two independent signals, both
// fail-closed:
//
//   1. isPreviewHost(hostname) — requests to *.workers.dev (Cloudflare
//      Workers Builds PR-branch deploys) reveal every scheduled post.
//   2. verifyPreviewGrant(token, key) — a signed, expiring link reveals
//      exactly ONE post, on any host including production. The token may also
//      name a reviewer, which additionally authorises leaving galley notes on
//      that post (see CLAUDE.md, "The galley"). verifyPreviewToken is the
//      viewing half of the same check, kept for callers that only need the slug.
//
// Every token also carries a link id naming its row in the preview_links
// allowlist, which is what makes a link revocable. The lookup itself is NOT
// here: this module stays free of any database dependency so one copy serves
// the Worker, `node --test`, and scripts/preview-link.mjs. src/middleware.ts
// does the lookup and refuses a grant whose row is missing or revoked.
//
// Plain JS for the same reason as schedule.js and csp.js: `node --test`
// imports it directly, no TypeScript tooling on the test side. It uses
// globalThis.crypto.subtle, which exists in both the Cloudflare Worker and
// Node 22 — so this single module also backs scripts/preview-link.mjs, and
// the code that mints links is literally the code that verifies them.
//
// Scope note: a signed token unlocks the post's own URL only. It is
// deliberately NOT plumbed into the blog index, tag pages, or the RSS feed —
// RSS drives Buttondown's email — an irreversible send to real subscribers —
// and a preview link must never be able to reach it. See CLAUDE.md,
// "Scheduled publishing".

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
 * Shape of a link id — the field that makes a preview link revocable.
 *
 * 64 bits of randomness as lowercase hex: unguessable, dot-free (so it cannot
 * shift a field boundary in the token), and short enough to paste into a
 * `just preview-revoke` command by hand.
 *
 * Exported so scripts/links-db.mjs can shape-check an id before interpolating
 * it into SQL, and so scripts/preview-roster.mjs can reject a mistyped one with
 * a useful message.
 */
export const LINK_ID_RE = /^[0-9a-f]{16}$/;

/**
 * Mint a fresh link id.
 *
 * Random rather than derived: the id is an opaque handle for the row in
 * preview_links, and the signature already binds it to the slug, reviewer, and
 * expiry — so it needs unguessability and nothing else. `crypto.getRandomValues`
 * is present in the Worker and in Node 22 alike, same as the rest of this
 * module.
 *
 * @returns {string}
 */
export function newLinkId() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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
 * Two shapes, distinguished only by whether a reviewer is named:
 *
 *   `<slug>.<exp>.<linkId>.<sigHex>`            — view-only
 *   `<slug>.<exp>.<reviewer>.<linkId>.<sigHex>` — view AND leave galley notes
 *
 * The signed payload is everything before the signature, and `exp` is epoch
 * SECONDS (shorter and more scannable in a URL than milliseconds).
 *
 * Because the payload differs between the shapes, the two cannot be converted
 * into one another: stripping the reviewer out of a five-part token leaves a
 * signature over `<slug>.<exp>.<reviewer>.<linkId>` being checked against
 * `<slug>.<exp>.<linkId>`, which fails, and inventing a reviewer requires a
 * signature the holder of a view-only link cannot produce. Parsing stays
 * unambiguous because neither SLUG_RE nor LINK_ID_RE admits a dot, so no field
 * can smuggle in an extra boundary.
 *
 * Takes the same object shape verifyPreviewGrant returns, so minting and
 * verifying stay symmetric and the arity stops growing.
 *
 * @param {object} grant
 * @param {string} grant.slug post id, e.g. 'why-im-pivoting'
 * @param {number} grant.exp expiry as epoch seconds
 * @param {string} grant.linkId id of this link's row in preview_links. REQUIRED
 *   on both shapes — see the check below for why it is not defaulted.
 * @param {string | null} [grant.reviewer] short label identifying the editor.
 *   Chosen at mint time and recorded on every note they leave, so picking
 *   initials is what keeps the committed review file anonymous.
 * @param {string} key signing key (PREVIEW_SIGNING_KEY)
 * @returns {Promise<string>}
 */
export async function signPreviewToken({ slug, exp, linkId, reviewer = null }, key) {
  if (!key) throw new Error('signPreviewToken: signing key is required');
  if (!SLUG_RE.test(slug)) throw new Error(`signPreviewToken: invalid slug ${JSON.stringify(slug)}`);
  if (!Number.isInteger(exp) || exp < 0) throw new Error('signPreviewToken: exp must be a non-negative integer');
  if (reviewer !== null && !SLUG_RE.test(reviewer)) {
    throw new Error(`signPreviewToken: invalid reviewer ${JSON.stringify(reviewer)}`);
  }
  // Every link must be revocable, so every token carries an id. Mandatory
  // rather than defaulted: a token minted without one would be a grant the
  // allowlist has no row for, and therefore no way to withdraw.
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
 * Verify a preview token and return what it authorises, or null.
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
 * A `reviewer` of null means view-only. Granting the right to leave notes is
 * strictly an escalation over viewing, so it is carried INSIDE the signature
 * rather than as a separate query parameter — otherwise anyone holding a
 * read-only link could promote themselves by editing the URL.
 *
 * This function does NOT consult the allowlist: it stays free of any database
 * dependency so the same module runs in the Worker, under `node --test`, and in
 * scripts/preview-link.mjs. src/middleware.ts takes the returned `linkId` and
 * requires an active row in preview_links before honouring the grant.
 *
 * @param {string | null | undefined} token
 * @param {string | null | undefined} key signing key; absent ⇒ always null
 * @param {number} [now] epoch ms; defaults to the current time
 * @returns {Promise<{ slug: string, reviewer: string | null, linkId: string } | null>}
 */
export async function verifyPreviewGrant(token, key, now = Date.now()) {
  if (!token || !key) return null;

  const parts = token.split('.');
  // Four fields (view-only) or five (reviewer). Both PRE-ALLOWLIST shapes are
  // deliberately refused, because a token minted before link ids existed has no
  // row to revoke, and honouring it would leave a permanent grant outside the
  // allowlist:
  //
  //   - three fields is the old view-only shape, rejected on length here;
  //   - `<slug>.<exp>.<reviewer>.<sig>` is the old reviewer shape, which has
  //     four fields and so reaches the LINK_ID_RE check below — a reviewer
  //     label like `jd` is not 16 hex characters, so it fails there.
  //
  // The one collision that implies: a legacy reviewer token whose reviewer was
  // exactly 16 lowercase hex characters would parse as a new view-only token
  // over a byte-identical payload, and its signature would verify. It is
  // harmless — the allowlist refuses it for having no row — and unreachable in
  // practice, since reviewers are minted as initials and no legacy token was
  // ever issued (this shipped before the galley did).
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

  // The payload is every field except the signature, so the shape itself is
  // authenticated — a token cannot be re-read as the other shape.
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

  // Expiry is exclusive: a token whose exp is exactly now has expired.
  if (Number(exp) * 1000 <= now) return null;

  return { slug, reviewer, linkId };
}

/**
 * Verify a preview token and return the slug it authorises, or null.
 *
 * The viewing half of verifyPreviewGrant, kept as the name every existing
 * caller uses. Both token shapes grant viewing — an editor obviously has to
 * read the post to comment on it — so this deliberately does not care which
 * shape arrived.
 *
 * @param {string | null | undefined} token
 * @param {string | null | undefined} key
 * @param {number} [now] epoch ms
 * @returns {Promise<string | null>} the authorised slug, or null
 */
export async function verifyPreviewToken(token, key, now = Date.now()) {
  const grant = await verifyPreviewGrant(token, key, now);
  return grant === null ? null : grant.slug;
}
