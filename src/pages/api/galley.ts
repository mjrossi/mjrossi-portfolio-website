import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { getEnv, jsonError, jsonOk, methodNotAllowed, parseJson, refuse } from '../../lib/server.ts';
import { validateNote } from '../../lib/galley.js';
import { revisionOf } from '../../lib/post-source.ts';
import { isPublished } from '../../lib/schedule.js';

// Galley notes on a scheduled post. See docs/GALLEY.md.
//
// Authorisation comes entirely from middleware's locals: both methods require
// `previewReviewer`, and a grant names ONE post. There is deliberately no
// cross-post mode. Once the post publishes, both methods refuse.

export const prerender = false;

// The revision hash lives in post-source.ts, shared with BlogPost.astro: two
// definitions would refuse every write.

// Per reviewer per hour. Far above any real round; bounds a leaked link.
const MAX_NOTES_PER_REVIEWER = 60;
const RATE_WINDOW_MS = 60 * 60 * 1000;

// Read ceilings, applied to open and closed notes separately so an old round
// cannot crowd out the current one. Closed notes get less: they sit behind a
// collapsed <details>, grow for the life of the post, and the margin refetches
// on every tab focus.
const MAX_NOTES_RETURNED = 500;
const MAX_CLOSED_RETURNED = 100;

// pubDate from the parsed, schema-validated collection rather than re-parsing
// the raw frontmatter here. Memoised: only requests with a valid token need it.
let pubDates: Map<string, Date> | null = null;
async function publicationOf(slug: string): Promise<Date | undefined> {
  if (pubDates === null) {
    pubDates = new Map((await getCollection('blog')).map((post) => [post.id, post.data.pubDate]));
  }
  return pubDates.get(slug);
}

/**
 * The one authorisation gate. Returns the post and reviewer, or a Response.
 *
 * Publication ends a grant. Minting caps a link at pubDate, but moving pubDate
 * EARLIER afterwards is normal, so the endpoint checks too — the layout only
 * decides whether the margin is drawn, this decides whether a note is written.
 *
 * An unknown slug falls through on purpose, so nothing here answers "unknown
 * post" to a cross-slug token. POST still has to match the note's slug and find
 * a real post; GET for a slug with no post finds no notes.
 */
async function authorize(
  locals: App.Locals,
): Promise<{ slug: string; reviewer: string } | Response> {
  const slug = locals.previewSlug;
  const reviewer = locals.previewReviewer;
  // Truthiness, not `!== null`: undefined (middleware didn't run) is denied.
  if (!slug || !reviewer) return jsonError(403, 'not_authorised');

  const pubDate = await publicationOf(slug);
  if (pubDate !== undefined && isPublished(pubDate)) return jsonError(403, 'post_published');

  return { slug, reviewer };
}

function db() {
  const binding = getEnv().DB;
  if (!binding) return null;
  return binding;
}

// Named, so a missing migration ("no such table") reads off the response
// instead of the Worker logs.
function dbError(err: unknown): Response {
  console.error('galley: D1 query failed', err);
  return jsonError(500, 'galley_db_error');
}

export const GET: APIRoute = async ({ locals }) => {
  const grant = await authorize(locals);
  if (grant instanceof Response) return grant;

  const DB = db();
  if (!DB) return jsonError(500, 'galley_db_missing');

  // Scoped to the granted slug, never the query string. Not scoped to the
  // reviewer: editors see each other's notes so feedback isn't re-filed.
  //
  // Bounded because the write quota caps a RATE, not a total. Newest first,
  // then re-sorted, so a flood pushes out the oldest notes. `revision_hash` is
  // folded into `stale` rather than returned; `closed_at` is implied by which
  // array a note is in.
  const notesFor = (closed: boolean) =>
    DB.prepare(
      `SELECT * FROM (
         SELECT id, reviewer, kind, src_start, src_end, quote, body, suggestion,
                created_at, revision_hash
           FROM galley_notes
          WHERE slug = ? AND closed_at IS ${closed ? 'NOT NULL' : 'NULL'}
          ORDER BY created_at DESC
          LIMIT ?
       ) ORDER BY created_at ASC`,
    )
      .bind(grant.slug, closed ? MAX_CLOSED_RETURNED : MAX_NOTES_RETURNED)
      .all();

  // The revision being served now: per note (has its anchor drifted?) and for
  // the page (is the document the client rendered still current?).
  const currentRevision = await revisionOf(grant.slug);

  let open;
  let closed;
  try {
    [open, closed] = await Promise.all([notesFor(false), notesFor(true)]);
  } catch (err) {
    return dbError(err);
  }

  // A stale note's `src_start` is a line number in a file that has changed; the
  // client withholds its in-body marker.
  const shape = (row: Record<string, unknown>) => {
    const { revision_hash: recorded, ...rest } = row;
    return { ...rest, stale: recorded !== currentRevision };
  };

  return jsonOk({
    slug: grant.slug,
    reviewer: grant.reviewer,
    // Already on the page as `data-revision`; lets the client tell its own
    // render is older than this response.
    revision: currentRevision ?? null,
    notes: (open.results ?? []).map(shape),
    closed: (closed.results ?? []).map(shape),
  });
};

// Early returns go through `refuse` to drain the body (see server.ts). This is
// the path that gets hit: a revoked link's client keeps posting.
export const POST: APIRoute = async ({ locals, request }) => {
  const grant = await authorize(locals);
  if (grant instanceof Response) return refuse(request, grant);

  const DB = db();
  if (!DB) return refuse(request, jsonError(500, 'galley_db_missing'));

  // Bytes against caps counted in characters: LIMITS sums to 9,400 characters,
  // up to ~28KB in CJK. Four bytes a character means the transport cap never
  // pre-empts validateNote's field-specific "too long" message.
  const parsed = await parseJson<Record<string, unknown>>(request, { maxBytes: 48_000 });
  if (!parsed.ok) return parsed.response;

  const result = validateNote(parsed.data);
  if (!result.ok) return jsonError(400, result.error);
  const note = result.note;

  // A valid token for another draft must not file a note against this one.
  if (note.slug !== grant.slug) return jsonError(403, 'slug_mismatch');

  // THE PAGE THE NOTE CAME FROM MUST STILL BE THE POST WE HAVE. `src` is a line
  // range from whatever build the browser loaded. Stored against the current
  // hash, an old page's anchors would look fresh and point at the wrong prose —
  // silently wrong rather than visibly stale. So the client echoes the page's
  // revision and a mismatch is refused. revisionOf also answers "is this a real
  // post?". (Plain jsonError from here: parseJson already drained the body.)
  const currentRevision = await revisionOf(note.slug);
  if (currentRevision === undefined) return jsonError(404, 'unknown_post');
  if (parsed.data.revision !== currentRevision) return jsonError(409, 'stale_page');

  // The quota and the write are ONE statement. A COUNT then an INSERT lets N
  // concurrent requests all pass the same pre-flood count; INSERT ... SELECT
  // ... WHERE cannot. A refusal is zero rows changed, not an error.
  let inserted;
  try {
    inserted = await DB.prepare(
      // Open by default: closed_at is NULL (migrations/0003 dropped `status`).
      `INSERT INTO galley_notes
         (id, slug, revision_hash, reviewer, kind, src_start, src_end,
          quote, prefix, suffix, body, suggestion, created_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM galley_notes
                WHERE slug = ? AND reviewer = ? AND created_at > ?) < ?`,
    )
      .bind(
        crypto.randomUUID(),
        note.slug,
        currentRevision,
        // From the signed token, never the body.
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
        // Quota: this slug and this reviewer, so one editor can't spend another's.
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

// A PUT or PATCH can carry a body too.
export const ALL: APIRoute = ({ request }) => refuse(request, methodNotAllowed('GET, POST'));
