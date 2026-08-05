-- Initial schema for the mjrossi-galley database.
--
-- Two tables, one per half of editorial review:
--
--   preview_links -- who may see an unpublished post, and who may comment on
--                    it. Authorisation.
--   galley_notes  -- what they said. Content.
--
-- preview_links comes first because nothing can write a note without a live
-- link, and reading this file top-down should follow that order.
--
-- This database holds the CONVERSATION about a post, never the post. Posts stay
-- in git as MDX -- that split is deliberate. Notes are ephemeral, relational
-- collaboration state (many notes x many reviewers x per revision); a post is a
-- durable versioned artifact whose history is worth reading.


-- ── preview_links ───────────────────────────────────
--
-- The allowlist that makes a signed preview link revocable.
--
-- Every preview token carries a random id (src/lib/preview.js newLinkId) inside
-- its signature, naming a row here. src/middleware.ts requires that row,
-- un-revoked, before the token grants anything at all -- reading included.
-- Without it the scheme would be stateless and therefore irrevocable: a link
-- handed to the wrong person would stay live until it expired, and the only
-- kill switch would be rotating PREVIEW_SIGNING_KEY, which invalidates every
-- outstanding link at once and cannot be scoped to one.
--
-- BOTH link shapes are recorded. `reviewer` is NULL for a view-only link and
-- set for a review link; that is the only difference between the two rows. A
-- view-only link is still an unpublished draft handed to someone, so it gets
-- the same withdrawal path.
--
-- The cost, accepted deliberately: this puts every preview link behind D1,
-- minting included. `just preview-link` needs an API token carrying D1:Edit
-- (or --local), and while D1 is unavailable no preview link works. That is
-- recoverable and immediately visible; links that cannot be withdrawn are
-- neither.
--
-- NOT every way of seeing a draft goes through here. The *.workers.dev host
-- unlock in src/lib/preview.js reveals every scheduled post with no link and no
-- row at all -- see CLAUDE.md, "Previewing a scheduled post".

CREATE TABLE IF NOT EXISTS preview_links (
  -- The id inside the token. Written by scripts/preview-link.mjs at mint time.
  id         TEXT PRIMARY KEY,

  -- Mirror the signed payload, so the operator can answer "what is outstanding
  -- for this draft?" without holding the links themselves -- the inventory this
  -- table provides alongside revocation.
  slug       TEXT NOT NULL,
  reviewer   TEXT,               -- NULL means view-only; see above
  exp        INTEGER NOT NULL,   -- epoch SECONDS, like the token

  -- epoch MS, like galley_notes.created_at below. Note the mismatch with `exp`:
  -- each column matches the thing it mirrors rather than its neighbour here, so
  -- "fixing" either one breaks agreement somewhere else.
  created_at INTEGER NOT NULL,

  -- NULL means active. Set to revoke; rows are never deleted, so a withdrawn
  -- link stays visible in the inventory rather than silently disappearing.
  revoked_at INTEGER
);

-- The one operator query: "every link for this post, oldest first".
CREATE INDEX IF NOT EXISTS idx_preview_links_slug ON preview_links (slug, created_at);


-- ── galley_notes ────────────────────────────────────
--
-- Inline editorial feedback on scheduled posts, each note anchored to the
-- passage it is about. Named for the galley proof -- the pre-publication print
-- sent out for correction.

CREATE TABLE IF NOT EXISTS galley_notes (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL,

  -- SHA-256 of the ENTIRE .mdx file, frontmatter included, as it stood when
  -- the note was left. src_start/src_end are absolute line numbers in that
  -- file, so any edit above the anchor moves it. The pull script compares this
  -- against the file on disk and flags a mismatch as "verify the quote" --
  -- which is the normal case by the second review round, not an error.
  revision_hash TEXT NOT NULL,

  -- Short label chosen when the preview link was minted, carried inside the
  -- token's signature (`just preview-link <slug> --reviewer jd`). Mint with
  -- initials and the committed review file is anonymous with no separate
  -- anonymisation step.
  reviewer      TEXT NOT NULL,

  kind          TEXT NOT NULL CHECK (kind IN ('comment', 'suggestion')),

  -- Nullable together: a note with no anchor is a whole-draft comment.
  src_start     INTEGER,
  src_end       INTEGER,

  -- The selected text plus surrounding context. This is what still identifies
  -- the passage once the line numbers have drifted.
  quote         TEXT,
  prefix        TEXT,
  suffix        TEXT,

  -- body is the editor's prose; suggestion is replacement text. A comment has
  -- body; a suggestion has suggestion and may have body. Enforced in
  -- src/lib/galley.js rather than here, so the endpoint can name which field
  -- was wrong.
  body          TEXT,
  suggestion    TEXT,

  -- Reserved, and currently write-once: every row is 'open' and nothing can
  -- change it. Marking a note resolved would need an endpoint that mutates
  -- other people's notes, and this feature deliberately has no admin surface --
  -- notes are read with `wrangler d1 execute`, already authenticated as the
  -- operator. The column stays because a review round is where that workflow
  -- would land, but /api/galley does not return it: a constant shipped to the
  -- client only reads as though it meant something.
  status        TEXT NOT NULL DEFAULT 'open',
  created_at    INTEGER NOT NULL
);

-- Every read is "all notes for this post, oldest first" -- the margin renders
-- them in order and the pull script groups them by anchor.
CREATE INDEX IF NOT EXISTS idx_galley_slug ON galley_notes (slug, created_at);
