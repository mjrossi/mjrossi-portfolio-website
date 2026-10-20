// Validation and hashing for galley notes, shared by /api/galley and
// scripts/galley-pull.mjs: the code that accepts a note is the code that reads
// it back.

/** Field caps. Only `body` and `suggestion` are typed freely; the rest are machine-made. */
export const LIMITS = {
  body: 4000,
  suggestion: 4000,
  quote: 1000,
  context: 200,
};

/** The kinds of note a reviewer can leave. Mirrors the CHECK on galley_notes.kind. */
export const KINDS = new Set(['comment', 'suggestion']);

/**
 * Same as preview.js's SLUG_RE but deliberately not imported: a change to note
 * validation must not silently widen authorisation. The tests pin the pairing.
 */
const ID_RE = /^[a-z0-9-]+$/;

/** `"42-47"` → `{ start: 42, end: 47 }`, else null. */
export function parseSrc(src) {
  if (typeof src !== 'string') return null;
  const m = /^(\d{1,7})-(\d{1,7})$/.exec(src);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  // Backwards means hand-edited; no sensible way to apply it.
  if (start < 1 || end < start) return null;
  return { start, end };
}

/**
 * SHA-256 of a string, lowercase hex.
 *
 * Callers MUST hash the ENTIRE .mdx, frontmatter included: anchors are absolute
 * line numbers, so one added tag shifts them all while the prose is untouched.
 *
 * @param {string} text
 * @returns {Promise<string>}
 */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Keeps "too long" distinct from "absent". */
const TOO_LONG = Symbol('too-long');

/**
 * Trim a field: absent, non-string or empty → null; over `max` → TOO_LONG.
 * Rejected rather than truncated, so the editor finds out while the note is
 * still on screen.
 */
function clean(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > max) return TOO_LONG;
  return trimmed;
}

/**
 * Validate a note from the review client. Never throws.
 *
 * `slug` is checked for SHAPE only; whether the reviewer may write to it is the
 * endpoint's question, answered against the signed grant.
 *
 * @param {unknown} input parsed JSON body
 * @returns {{ ok: true, note: object } | { ok: false, error: string }}
 */
export function validateNote(input) {
  if (typeof input !== 'object' || input === null) return { ok: false, error: 'invalid_body' };

  const { slug, kind = 'comment', src, quote, prefix, suffix, body, suggestion } = input;

  if (typeof slug !== 'string' || !ID_RE.test(slug)) return { ok: false, error: 'invalid_slug' };
  if (typeof kind !== 'string' || !KINDS.has(kind)) return { ok: false, error: 'invalid_kind' };

  const fields = {
    body: clean(body, LIMITS.body),
    suggestion: clean(suggestion, LIMITS.suggestion),
    quote: clean(quote, LIMITS.quote),
    prefix: clean(prefix, LIMITS.context),
    suffix: clean(suffix, LIMITS.context),
  };
  for (const [name, value] of Object.entries(fields)) {
    if (value === TOO_LONG) return { ok: false, error: `${name}_too_long` };
  }

  // A suggestion needs its replacement text; the explanation is optional.
  if (kind === 'comment' && fields.body === null) return { ok: false, error: 'body_required' };
  if (kind === 'suggestion' && fields.suggestion === null) {
    return { ok: false, error: 'suggestion_required' };
  }

  // Absent is a whole-draft note. Malformed is refused.
  const hasSrc = src !== undefined && src !== null && src !== '';
  const range = hasSrc ? parseSrc(src) : null;
  if (hasSrc && range === null) return { ok: false, error: 'invalid_src' };

  return {
    ok: true,
    note: {
      slug,
      kind,
      srcStart: range?.start ?? null,
      srcEnd: range?.end ?? null,
      quote: fields.quote,
      prefix: fields.prefix,
      suffix: fields.suffix,
      body: fields.body,
      suggestion: fields.suggestion,
    },
  };
}
