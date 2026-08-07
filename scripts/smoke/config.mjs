// Shared constants for the smoke suite. Everything here is inert data — no
// assertions, no I/O beyond reading content frontmatter — so importing this
// module can never change what the run does or the order it does it in.
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { isPublished } from '../../src/lib/schedule.js';
import { CONTENT_DIR, readPubDate } from '../content.mjs';
import { readDevVar } from '../dev-vars.mjs';

export const DIST = resolve('dist/client');
export const PORT = Number(process.env.SMOKE_PORT ?? 8788);
export const BASE = `http://127.0.0.1:${PORT}`;
export const READY_TIMEOUT_MS = 30_000;

// ── the posts the matrices key off ─────────────────

// The permanently-future-dated post in src/content/blog/.
export const FIXTURE_SLUG = 'smoke-scheduled-fixture';
export const FIXTURE_TAG = 'smoke-fixture';
// Names no real post: a token minted for another draft must not open or write
// to the fixture.
export const OTHER_SLUG = 'some-other-draft';
// Also names no real post. Separate from OTHER_SLUG because `extendLinks` is a
// bulk UPDATE over one post's rows, and the cross-slug fixtures on OTHER_SLUG
// are read at a far-future expiry long afterwards — see the `extend --all:
// leaves another post's links alone` assertion, which pins exactly that.
export const EXTEND_SLUG = 'a-third-draft';

// A post that is ALREADY PUBLISHED, for the other end of a link's life: minting
// caps a link's expiry at pubDate, but that cap is a snapshot, and moving
// pubDate earlier afterwards (which the authoring workflow does at step 5)
// leaves a live row on a public post. The galley must be shut anyway.
//
// Discovered rather than named, so this cannot rot into pointing at a post whose
// date moved — every real post is past-dated today, and the fixture is the only
// scheduled one, but that is a fact about the content and not a contract.
//
// Undefined when no published post exists; the entry point reports that and
// bails, rather than this module exiting during an import.
export const PUBLISHED_SLUG = readdirSync(CONTENT_DIR)
  .map((entry) => entry.replace(/\.mdx$/, ''))
  .filter((slug) => slug !== FIXTURE_SLUG)
  .sort()
  .find((slug) => {
    try {
      const pubDate = readPubDate(slug);
      return pubDate !== null && isPublished(pubDate);
    } catch {
      return false;
    }
  });

// ── galley ─────────────────────────────────────────

// Must match wrangler.jsonc's database_name.
export const GALLEY_DB = 'mjrossi-galley';
// Scoped to smoke so a real review file can never be confused with test rows.
export const SMOKE_REVIEWER = 'smoke-reviewer';
// Mirrors MAX_NOTES_PER_REVIEWER in src/pages/api/galley.ts. Asserted against
// the source rather than imported — the endpoint is TypeScript and this suite
// runs under bare node.
export const GALLEY_WRITE_QUOTA = 60;

// ── clocks ─────────────────────────────────────────
//
// A link has TWO expiries since migrations/0002: the row's `exp`, which
// isLinkActive enforces and `just preview-extend` moves, and the token's, which
// is signed and is the ceiling above it. Both have to pass. Fixture rows are
// far-future unless the assertion using them is specifically about expiry.
export const FAR_FUTURE_EXP = 4102444800; // 2100-01-01
export const NOW_SEC = Math.floor(Date.now() / 1000);

// ── signing ────────────────────────────────────────
//
// Sign with whatever key the worker will actually hold. wrangler dev reads
// .dev.vars and that wins over --var, so a developer with a real key there
// would otherwise see the positive-path assertions fail locally while CI
// (no .dev.vars) passed — the worst kind of flake. Mirror the precedence,
// using the same parser scripts/preview-link.mjs signs with so quoting can't
// drift between them.
const devVarsKey = readDevVar('PREVIEW_SIGNING_KEY');
export const PREVIEW_KEY = devVarsKey ?? 'smoke-only-preview-signing-key';
// Only inject a key when .dev.vars didn't supply one.
export const PREVIEW_KEY_ARGS = devVarsKey ? [] : ['--var', `PREVIEW_SIGNING_KEY:${PREVIEW_KEY}`];
