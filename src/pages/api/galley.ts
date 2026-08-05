import type { APIRoute } from 'astro';
import { getEnv, jsonError, jsonOk, methodNotAllowed, parseJson } from '../../lib/server.ts';
import { sha256Hex, validateNote } from '../../lib/galley.js';

// Galley notes — inline editorial review on scheduled posts. See CLAUDE.md.
//
// AUTHORISATION comes entirely from src/middleware.ts, which has already
// verified the signed `?preview=` token and put the result on locals. Both
// methods require `previewReviewer` — a view-only link resolves that to null,
// so being able to read a draft never implies being able to write to it.
//
// The scoping rule that matters: a grant names ONE post, and this endpoint
// refuses to touch any other. It deliberately has no "list every post with
// notes" mode, because the whole point of scoping signed links is that handing
// someone a draft doesn't hand them the rest of the drafts.

export const prerender = false;

// Raw post sources, inlined at build time by Vite.
//
// Two jobs. It confirms a slug names a real post, and it lets the revision
// hash be computed HERE rather than trusted from the client — a browser has no
// way to know the file's bytes, and a note that misreports which revision it
// was written against would defeat the drift warning it exists to raise.
//
// The whole file is hashed, frontmatter included, because anchors are absolute
// line numbers: adding one tag shifts every one of them. See src/lib/galley.js.
//
// COST, known and accepted: this inlines every post's raw MDX into the worker
// bundle — ~84KB across 7 posts, growing linearly — when all the endpoint
// actually needs is a slug→hash map. Precomputing that at build time would take
// a Vite plugin or a generator step, plus a guarantee that it hashes byte-for-byte
// what `sha256Hex` would, which is a new way for the drift warning to go
// silently wrong. Not worth it at this size. Revisit past a few dozen posts, or
// sooner if the worker bundle starts mattering for cold starts.
const RAW_POSTS = import.meta.glob('/src/content/blog/**/*.mdx', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// '/src/content/blog/why-im-pivoting.mdx'       → 'why-im-pivoting'
// '/src/content/blog/some-post/index.mdx'       → 'some-post'
// Mirrors how Astro's content collection derives an entry id from its path.
const SOURCE_BY_SLUG = new Map<string, string>(
  Object.entries(RAW_POSTS).map(([path, raw]) => {
    const rel = path.replace('/src/content/blog/', '').replace(/\.mdx$/, '');
    return [rel.endsWith('/index') ? rel.slice(0, -'/index'.length) : rel, raw];
  }),
);

// Bounds a leaked link. Far above any real review round — the longest editorial
// pass on this blog produced well under a dozen notes — and low enough that a
// link handed to the wrong person can't fill the table.
const MAX_NOTES_PER_REVIEWER = 60;
const RATE_WINDOW_MS = 60 * 60 * 1000;

// Ceiling on a single read. Far above any real review round — see above — and
// low enough that a flooded table can't turn every GET into a huge response.
const MAX_NOTES_RETURNED = 500;

/** The one authorisation gate. Returns the post and reviewer, or a Response. */
function authorize(locals: App.Locals): { slug: string; reviewer: string } | Response {
  const slug = locals.previewSlug;
  const reviewer = locals.previewReviewer;
  // Deliberately checks for truthiness rather than `!== null`: middleware
  // leaves these undefined when it hasn't run, and undefined must mean denied.
  if (!slug || !reviewer) return jsonError(403, 'not_authorised');
  return { slug, reviewer };
}

function db() {
  const binding = getEnv().DB;
  if (!binding) return null;
  return binding;
}

// A missing BINDING and a missing TABLE are different failures with the same
// symptom, and the second is the one that actually happens: forgetting
// `wrangler d1 migrations apply --remote` throws "no such table" out of the
// handler, which reaches the editor as the generic "Could not save that note."
// Naming it means the operator can read the cause off the response instead of
// going to Worker logs. Same reasoning as the named binding errors in
// /api/subscribe.
function dbError(err: unknown): Response {
  console.error('galley: D1 query failed', err);
  return jsonError(500, 'galley_db_error');
}

export const GET: APIRoute = async ({ locals }) => {
  const grant = authorize(locals);
  if (grant instanceof Response) return grant;

  const DB = db();
  if (!DB) return jsonError(500, 'galley_db_missing');

  // Scoped to the granted slug rather than to anything in the query string —
  // there is no way to ask this endpoint about a post you weren't given.
  //
  // Bounded, because MAX_NOTES_PER_REVIEWER caps the write RATE and not the
  // total: a leaked link that is topped up every hour for its full window can
  // still accumulate thousands of rows, and every subsequent read serialises
  // all of them into one response that a real editor's browser then renders.
  // The newest are taken and re-sorted ascending, so a flood pushes out the
  // oldest notes rather than burying the ones being written now.
  //
  // `status` is deliberately not selected. It is written once as 'open' and
  // there is nothing that can change it — resolving a note would need an admin
  // surface, which this feature deliberately does not have. Shipping a constant
  // to the client only invites a reader to believe it means something.
  let results;
  try {
    ({ results } = await DB.prepare(
      `SELECT * FROM (
         SELECT id, reviewer, kind, src_start, src_end, quote, body, suggestion, created_at
           FROM galley_notes
          WHERE slug = ?
          ORDER BY created_at DESC
          LIMIT ?
       ) ORDER BY created_at ASC`,
    )
      .bind(grant.slug, MAX_NOTES_RETURNED)
      .all());
  } catch (err) {
    return dbError(err);
  }

  return jsonOk({ slug: grant.slug, reviewer: grant.reviewer, notes: results ?? [] });
};

export const POST: APIRoute = async ({ locals, request }) => {
  const grant = authorize(locals);
  if (grant instanceof Response) return grant;

  const DB = db();
  if (!DB) return jsonError(500, 'galley_db_missing');

  // Larger than /api/subscribe's 1KB default: a note carries the editor's
  // prose plus the quoted passage and its context.
  //
  // Sized in BYTES against caps counted in CHARACTERS. LIMITS sums to 9,400
  // characters, which is ~9.4KB of Latin text but ~28KB of CJK — so a cap set
  // near the character sum would 413 a perfectly valid note before
  // validateNote ever saw it, and the field-specific "too long" message the
  // editor needs would never be reached. Four bytes per character covers every
  // UTF-8 encoding, so the transport cap only ever catches genuinely oversize
  // bodies and LIMITS stays the thing that rejects a too-long note.
  const parsed = await parseJson<Record<string, unknown>>(request, { maxBytes: 48_000 });
  if (!parsed.ok) return parsed.response;

  const result = validateNote(parsed.data);
  if (!result.ok) return jsonError(400, result.error);
  const note = result.note;

  // The grant names one post. A token minted for another draft cannot file a
  // note against this one even though its signature is perfectly valid — the
  // case a signature check alone cannot catch.
  if (note.slug !== grant.slug) return jsonError(403, 'slug_mismatch');

  const source = SOURCE_BY_SLUG.get(note.slug);
  if (source === undefined) return jsonError(404, 'unknown_post');

  // The quota and the write are ONE statement, and that is the whole point.
  //
  // A `SELECT COUNT(*)` followed by a separate `INSERT` is two round-trips
  // across two Worker invocations: N concurrent requests all read the same
  // pre-flood count, all pass the check, and all insert. The quota is the
  // stated bound on a leaked review link, so a bound that only holds against a
  // sequential client is not a bound at all.
  //
  // `INSERT ... SELECT ... WHERE` is evaluated by SQLite as a single statement,
  // so the count cannot be observed and then invalidated before the row lands.
  // A refusal shows up as zero rows changed rather than as an error.
  let inserted;
  try {
    inserted = await DB.prepare(
      `INSERT INTO galley_notes
         (id, slug, revision_hash, reviewer, kind, src_start, src_end,
          quote, prefix, suffix, body, suggestion, status, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?
        WHERE (SELECT COUNT(*) FROM galley_notes
                WHERE slug = ? AND reviewer = ? AND created_at > ?) < ?`,
    )
      .bind(
        crypto.randomUUID(),
        note.slug,
        await sha256Hex(source),
        // Reviewer comes from the signed token, never from the request body, so
        // a note cannot be attributed to an editor who did not write it.
        grant.reviewer,
        note.kind,
        note.srcStart,
        note.srcEnd,
        note.quote,
        note.prefix,
        note.suffix,
        note.body,
        note.suggestion,
        Date.now(),
        // The quota subquery. Scoped to the granted slug and the token's own
        // reviewer, so one editor cannot exhaust another's allowance.
        grant.slug,
        grant.reviewer,
        Date.now() - RATE_WINDOW_MS,
        MAX_NOTES_PER_REVIEWER,
      )
      .run();
  } catch (err) {
    return dbError(err);
  }

  if (inserted.meta.changes === 0) return jsonError(429, 'too_many_notes');

  return jsonOk({ ok: true });
};

export const ALL: APIRoute = () => methodNotAllowed('GET, POST');
