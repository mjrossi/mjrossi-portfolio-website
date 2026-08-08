import type { APIRoute } from 'astro';
import { getCollection } from 'astro:content';
import { getEnv, jsonError, jsonOk, methodNotAllowed, parseJson, refuse } from '../../lib/server.ts';
import { validateNote } from '../../lib/galley.js';
import { revisionOf } from '../../lib/post-source.ts';
import { isPublished } from '../../lib/schedule.js';

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
//
// And a grant ends when the post does. Once pubDate has passed the draft is
// public, the review round is over, and both methods refuse — see authorize().

export const prerender = false;

// The raw post sources, and the revision hash over them, live in
// src/lib/post-source.ts, because src/layouts/BlogPost.astro needs the identical
// hash: it stamps the rendered page with the revision, and POST below refuses a
// note whose page has since moved. Two definitions of that hash would refuse
// every write. `revisionOf` also answers "is this a real post?", which is why
// nothing here imports the source map directly any more.

// Bounds a leaked link. Far above any real review round — the longest editorial
// pass on this blog produced well under a dozen notes — and low enough that a
// link handed to the wrong person can't fill the table.
const MAX_NOTES_PER_REVIEWER = 60;
const RATE_WINDOW_MS = 60 * 60 * 1000;

// Ceiling on a single read, applied to open and closed notes SEPARATELY — a
// round that closed cannot crowd out the round in progress, which is the one the
// margin is for. Far above any real review round — see above — and low enough
// that a flooded table can't turn every GET into a huge response.
const MAX_NOTES_RETURNED = 500;

// Closed notes get a tighter ceiling than open ones, because they are read on
// different terms. The open set is the working list and every item is on screen;
// the closed set sits behind a collapsed <details> that most reads never open,
// and it grows monotonically for the life of the post while the open set is
// emptied every round. Since the margin now refreshes on tab focus, that
// appendix would otherwise be re-fetched all day to be hidden. Still far above
// any real post's accumulated rounds, and the count in the summary is this
// array's length either way — a truncated one under-reports rather than lying
// about a number nothing else can corroborate.
const MAX_CLOSED_RETURNED = 100;

// When each post goes live, from the collection rather than from RAW_POSTS above.
// The raw strings would need their frontmatter parsed here, in the worker, by
// code that would have to reproduce YAML's rules exactly — and getting them
// wrong by one time zone is the failure src/lib/pubdate.js exists to prevent.
// The collection has already parsed and schema-validated every one of them.
//
// Memoised rather than computed at module scope: this is only ever needed on a
// request that arrived with a valid preview token, which is rare, and it keeps
// module initialisation synchronous.
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
 * PUBLICATION ENDS A GRANT. A galley link exists to collect corrections on a
 * draft; once the post is public there is nothing left to correct in private,
 * and notes filed against it would arrive in a review round that closed. Minting
 * already caps a link's expiry at pubDate, so a link normally expires as its post
 * goes live and never reaches here — but that cap is a snapshot taken at mint
 * time, and moving pubDate EARLIER afterwards is what the authoring workflow does
 * at step 5. This is the check that holds in that case.
 *
 * Enforced HERE and not only in BlogPost.astro's render condition, because that
 * one governs whether the margin is drawn and this one governs whether a note can
 * be written. A client that keeps posting after the chrome disappears — or one
 * driven by hand — has to meet the same rule.
 *
 * A slug the collection does not know falls THROUGH this check rather than being
 * refused here, and that is deliberate. Publication can only end a grant for a
 * post that exists, and refusing early would answer "unknown post" to the
 * cross-slug case — a valid token for another draft — which is refused a few
 * lines further down for the reason that actually matters. Nothing is widened:
 * a POST still has to match `note.slug` and then find the post in
 * SOURCE_BY_SLUG, and a GET for a slug with no post finds no notes.
 */
async function authorize(
  locals: App.Locals,
): Promise<{ slug: string; reviewer: string } | Response> {
  const slug = locals.previewSlug;
  const reviewer = locals.previewReviewer;
  // Deliberately checks for truthiness rather than `!== null`: middleware
  // leaves these undefined when it hasn't run, and undefined must mean denied.
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
  const grant = await authorize(locals);
  if (grant instanceof Response) return grant;

  const DB = db();
  if (!DB) return jsonError(500, 'galley_db_missing');

  // Scoped to the granted slug rather than to anything in the query string —
  // there is no way to ask this endpoint about a post you weren't given.
  //
  // NOT scoped to the reviewer, and that is deliberate: an editor sees their
  // colleagues' notes so they don't re-file feedback someone has already left.
  // The write quota is per-reviewer, so sharing the read costs nothing.
  //
  // Bounded, because MAX_NOTES_PER_REVIEWER caps the write RATE and not the
  // total: a leaked link that is topped up every hour for its full window can
  // still accumulate thousands of rows, and every subsequent read serialises
  // all of them into one response that a real editor's browser then renders.
  // The newest are taken and re-sorted ascending, so a flood pushes out the
  // oldest notes rather than burying the ones being written now.
  //
  // `revision_hash` is selected but never returned — it is folded into `stale`
  // below. The client has no use for the hash itself, and shipping it would only
  // invite a reader to believe it meant something they could act on. `closed_at`
  // is not selected at all, for the same reason migrations/0003 dropped
  // `status`: which array a note arrives in already says whether it is closed,
  // so the column could only ever be a constant per query — NULL for every open
  // note — and a constant in a response is an invitation to read meaning into it.
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

  // The revision the SERVER is currently serving. Both a per-note comparison
  // (has this note's anchor drifted?) and a page-level one for the client (is
  // the document it rendered still the one being described?) — see the
  // `revision` field returned below.
  const currentRevision = await revisionOf(grant.slug);

  let open;
  let closed;
  try {
    // Two statements rather than one with a repeated-per-row subquery. This path
    // only runs on a request that already carried a valid signed preview token,
    // which is rare by construction, so the second round-trip costs nothing that
    // matters and the queries stay readable.
    [open, closed] = await Promise.all([notesFor(false), notesFor(true)]);
  } catch (err) {
    return dbError(err);
  }

  // A note whose recorded revision is not the current one has an anchor that no
  // longer means anything: `src_start` is an absolute line number in a file that
  // has since changed. The client uses this to withhold the in-body marker
  // rather than pointing at whatever now occupies those lines.
  const shape = (row: Record<string, unknown>) => {
    const { revision_hash: recorded, ...rest } = row;
    return { ...rest, stale: recorded !== currentRevision };
  };

  return jsonOk({
    slug: grant.slug,
    reviewer: grant.reviewer,
    // Not a new disclosure: the same hash is already on the page as
    // `data-revision`. It is here so the client can tell that the document it
    // rendered is older than the one this response describes, which is the only
    // way it can know its own anchors are all suspect.
    revision: currentRevision ?? null,
    notes: (open.results ?? []).map(shape),
    // No separate count field: it would be a second encoding of this array's
    // length, and the two would disagree the moment either hit MAX_NOTES_RETURNED.
    closed: (closed.results ?? []).map(shape),
  });
};

// Both early returns below go through `refuse`, which releases the request body
// this handler has decided not to read. See src/lib/server.ts: an unread body
// is free on production Cloudflare and fatal under `wrangler dev`, whose proxy
// hop is left holding a stream nobody drains until the dev server falls over.
// This is the path that gets hit — a revoked link's client keeps posting.
export const POST: APIRoute = async ({ locals, request }) => {
  const grant = await authorize(locals);
  if (grant instanceof Response) return refuse(request, grant);

  const DB = db();
  if (!DB) return refuse(request, jsonError(500, 'galley_db_missing'));

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

  // THE PAGE THE NOTE CAME FROM MUST STILL BE THE POST WE HAVE.
  //
  // `src` is a line range the client read from `data-src` in the HTML it has
  // loaded — which is whatever build that browser fetched, not necessarily this
  // one. A reviewer holding the post open across a revision therefore submits
  // the OLD revision's anchors, and without this check they would be stored
  // against the CURRENT revision's hash: a note that looks perfectly fresh, that
  // the drift machinery has no reason to question, and whose line numbers point
  // at prose it was never about. That is the one way a note can be silently
  // wrong rather than visibly stale.
  //
  // So the page carries its revision (BlogPost.astro → GalleyMargin's
  // data-revision), the client echoes it, and a mismatch is refused. The client
  // is never trusted to say what revision a note was written against — only to
  // prove it is looking at the current one. Same stance as galley-relocate.js
  // resolving an ambiguous quote to nothing: refuse rather than store something
  // that will be confidently wrong.
  //
  // Plain jsonError, not `refuse` — parseJson above has already drained the
  // body, so unlike every other early return in this handler there is nothing
  // left holding a stream open. See src/lib/server.ts.
  // Doubles as the "is this a real post?" check the SOURCE_BY_SLUG lookup used
  // to do on its own — revisionOf returns undefined for a slug with no file.
  const currentRevision = await revisionOf(note.slug);
  if (currentRevision === undefined) return jsonError(404, 'unknown_post');
  if (parsed.data.revision !== currentRevision) return jsonError(409, 'stale_page');

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
      // No `status` column: migrations/0003 dropped it. A note is open by
      // virtue of `closed_at` being NULL, which is also the default, so nothing
      // here has to say so.
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

// Same reasoning as POST's early returns: a PUT or PATCH can carry a body, and
// refusing it on the method alone must still release it.
export const ALL: APIRoute = ({ request }) => refuse(request, methodNotAllowed('GET, POST'));
