// Which database — and the refusal to guess.
//
// Three operator scripts read or write D1 (preview-link, preview-roster,
// galley-pull) and every one of them can act on either the production database
// or the local one `just preview` and `just smoke` use. They are not
// interchangeable, and the two ways of getting it wrong fail in opposite
// directions:
//
//   - meant local, got production: a real row written to the real allowlist, or
//     a revoke that withdraws a link an editor is actually holding.
//   - meant production, got local: a link that verifies and is then refused on
//     arrival, which looks exactly like the feature being broken.
//
// Neither announces itself. `--local` used to be an opt-in flag on a
// production default, so forgetting it was silent and the roster would report
// "no links minted" for a database it had never been pointed at.
//
// So there is no default. Every one of those commands requires --local or
// --remote, and prints which one it acted on. The cost is one flag per
// invocation; the thing it buys is that the destructive mistake needs a wrong
// flag rather than a missing one.
//
// Not applied to scripts/smoke.mjs, which is not operator-facing and is local
// by construction, or to library calls in links-db.mjs, which take the resolved
// boolean.

/**
 * Resolve --local / --remote into the boolean the d1.mjs helpers take.
 *
 * THROWS rather than exiting, so each script keeps its own die() prefix and the
 * message still names the tool the operator actually ran.
 *
 * @param {{ local?: boolean, remote?: boolean }} flags
 * @returns {boolean} true for the local database
 */
export function chooseDatabase({ local = false, remote = false } = {}) {
  if (local && remote) {
    throw new Error('pass either --local or --remote, not both');
  }
  if (!local && !remote) {
    throw new Error(
      'this command reads or writes D1, so it needs an explicit database:\n' +
        '    --remote   production — where real preview links and notes live\n' +
        '    --local    the dev database `just preview` and `just smoke` use\n' +
        '  There is deliberately no default. The two are not interchangeable:\n' +
        '  guessing production writes a real row, and guessing local hands out a\n' +
        '  link that is refused on arrival. Neither says so at the time.',
    );
  }
  return local;
}

/**
 * What to call the chosen database in output. One spelling everywhere, so
 * "production" always means the same thing across all three tools.
 *
 * @param {boolean} local
 * @returns {'local' | 'production'}
 */
export function databaseLabel(local) {
  return local ? 'local' : 'production';
}
