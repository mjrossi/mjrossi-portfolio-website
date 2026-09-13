import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLink, resolveNote } from '../../scripts/resolve-id.mjs';

// THE CROSS-POST INVARIANT, which is the whole of the review commands' scoping.
//
// It used to be a `WHERE slug = ? AND id = ?` clause, and a clause is hard to
// half-delete: drop a term and the statement still has to parse. Now that the
// slug being compared is DERIVED from the row it filters, that clause can only
// match -- so the store-level scoping assertions in scripts/smoke/fixtures.mjs
// stopped standing in for this the moment `just preview-revoke <id>` existed.
// What refuses a mistyped id is the explicit mismatch check in resolve(), and
// this file is the only thing that fails if it is deleted.
//
// This file lives under src/ rather than next to the module because `npm test`
// globs 'src/**/*.test.js' -- the same reason src/lib/d1-store.test.js sits here
// for scripts/d1-store.mjs, and src/lib/galley-quote.test.js for code served out
// of public/scripts/.
//
// `fetch` is the seam. The real one shells out to wrangler via execFileSync, so
// without it every case below would need a migrated local database and about a
// second of subprocess each. What that seam substitutes -- that a row really
// comes back carrying its slug -- is asserted against the real schema in
// scripts/smoke/fixtures.mjs, which is where a D1 question belongs.

/** A fetch that finds exactly one row, and records what it was asked for. */
function finds(row) {
  const asked = [];
  const fetch = async (id) => {
    asked.push(id);
    return row;
  };
  return { fetch, asked };
}

/** A fetch that finds nothing, like an id that was never minted. */
const findsNothing = async () => null;

/** `die` as a value: every refusal below is a thrown message. */
const boom = (message) => {
  throw new Error(message);
};

/** The refusal text, or null if the call was allowed through. */
async function refusalOf(run) {
  try {
    await run();
    return null;
  } catch (err) {
    return err.message;
  }
}

const LINK_ID = 'aaaa0000bbbb1111';
const NOTE_ID = '11111111-1111-4111-8111-111111111111';

test('resolveLink: an id alone derives the post from its row', async () => {
  const row = { id: LINK_ID, slug: 'some-draft', revoked_at: null };
  const { fetch, asked } = finds(row);
  const resolved = await resolveLink(boom, LINK_ID, { fetch });

  assert.equal(resolved.slug, 'some-draft');
  assert.equal(resolved.id, LINK_ID);
  assert.equal(resolved.row, row, 'the row is handed back so no caller reads twice');
  assert.deepEqual(asked, [LINK_ID], 'resolution is one lookup, by id alone');
});

test('resolveLink: a slug that agrees with the row passes through', async () => {
  const { fetch } = finds({ id: LINK_ID, slug: 'some-draft' });
  const resolved = await resolveLink(boom, LINK_ID, {
    slug: 'some-draft',
    fetch,
  });

  assert.equal(resolved.slug, 'some-draft', 'the old <slug> <id> form must still work');
});

test('resolveLink: a slug that disagrees with the row is refused, naming both posts', async () => {
  const { fetch } = finds({ id: LINK_ID, slug: 'some-draft' });
  const refusal = await refusalOf(() =>
    resolveLink(boom, LINK_ID, { slug: 'another-draft', fetch }),
  );

  assert.match(refusal, /some-draft/, 'the refusal must name the post the row is on');
  assert.match(refusal, /another-draft/, 'and the post the operator asked for');
});

test('resolveLink: a disagreeing slug refuses rather than preferring either side', async () => {
  // Preferring the row would act on a draft nobody named; preferring the slug
  // would find nothing and report an id that plainly exists as missing.
  const { fetch } = finds({ id: LINK_ID, slug: 'some-draft' });
  let acted = false;
  await refusalOf(async () => {
    await resolveLink(boom, LINK_ID, { slug: 'another-draft', fetch });
    acted = true;
  });

  assert.equal(acted, false, 'a disagreement must stop the command, not pick a winner');
});

test('resolveLink: an id with no row says how to find the real one', async () => {
  const refusal = await refusalOf(() => resolveLink(boom, LINK_ID, { fetch: findsNothing }));

  assert.match(refusal, new RegExp(LINK_ID), 'the refusal names the id that missed');
  assert.match(refusal, /preview-roster/, 'and the command that lists the real ones');
});

test('resolveLink: the database flag in the missing-row hint follows the target', async () => {
  const remote = await refusalOf(() => resolveLink(boom, LINK_ID, { fetch: findsNothing }));
  const local = await refusalOf(() =>
    resolveLink(boom, LINK_ID, { local: true, fetch: findsNothing }),
  );

  // Minting local and listing remote (or the reverse) is the likeliest cause of
  // a link that "does not exist", so the hint has to be runnable as printed.
  assert.match(remote, /--remote/);
  assert.match(local, /--local/);
});

test('resolveLink: something that is not an id shape never reaches the database', async () => {
  let looked = false;
  const fetch = async () => {
    looked = true;
    return null;
  };
  const refusal = await refusalOf(() => resolveLink(boom, 'some-draft', { fetch }));

  assert.match(refusal, /invalid link id/, 'a slug in the id position must say so');
  assert.equal(looked, false, 'shape is refused before a lookup is spent on it');
});

test('resolveNote: an id alone derives the post, for a closed note', async () => {
  const row = { id: NOTE_ID, slug: 'some-draft', closed_at: 1_700_000_000_000 };
  const { fetch } = finds(row);
  const resolved = await resolveNote(boom, NOTE_ID, { fetch });

  assert.equal(resolved.slug, 'some-draft');
  assert.equal(resolved.row.closed_at, 1_700_000_000_000, 'reopen needs the closed row itself');
});

test('resolveNote: a slug that disagrees with the row is refused, naming both posts', async () => {
  const { fetch } = finds({ id: NOTE_ID, slug: 'some-draft' });
  const refusal = await refusalOf(() =>
    resolveNote(boom, NOTE_ID, { slug: 'another-draft', fetch }),
  );

  assert.match(refusal, /some-draft/);
  assert.match(refusal, /another-draft/);
});

test('resolveNote: an id with no row says how to list the real ones', async () => {
  const refusal = await refusalOf(() => resolveNote(boom, NOTE_ID, { fetch: findsNothing }));

  assert.match(refusal, /no note/);
  assert.match(refusal, /just galley/);
});

test('resolveNote: a link id is not a note id', async () => {
  // The two shapes are disjoint, which is what lets galley-close tell a note id
  // from a slug by shape alone. A 16-hex link id is neither.
  const refusal = await refusalOf(() => resolveNote(boom, LINK_ID, { fetch: findsNothing }));

  assert.match(refusal, /invalid note id/);
});
