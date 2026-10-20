// Which database — and the refusal to guess.
//
// Every operator script that touches D1 requires --local or --remote and prints
// which. The two mistakes fail in opposite directions and both silently: local
// meant, production hit, is a real row or a real revoke; production meant, local
// hit, is a link refused on arrival. With no default, the destructive mistake
// needs a wrong flag rather than a missing one.

/**
 * Resolve --local / --remote. THROWS rather than exiting, so the caller's die()
 * names the tool.
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
 * The database's name in prose.
 *
 * @param {boolean} local
 * @returns {'local' | 'production'}
 */
export function databaseLabel(local) {
  return local ? 'local' : 'production';
}

/**
 * The database as the flag to type in a follow-up command.
 *
 * @param {boolean} local
 * @returns {'--local' | '--remote'}
 */
export function databaseFlag(local) {
  return local ? '--local' : '--remote';
}
