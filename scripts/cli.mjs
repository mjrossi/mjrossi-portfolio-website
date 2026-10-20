// The shared operator prologue: a `die` prefixed with the tool's name, the
// --local/--remote resolution, and the post-exists guard.
//
//   const { die, resolveDatabase, requirePost } = cli('galley-close');
//
// Argv parsing deliberately stays per script: each loop's refusal messages are
// written for that command's specific mistakes, and a parser general enough to
// keep them would be bigger than the loops, with no tests to catch drift.

import { chooseDatabase } from './database-target.mjs';
import { resolvePostSource } from './content.mjs';

/**
 * An absolute path as the operator would type it.
 *
 * @param {string} path
 * @returns {string}
 */
export function relativeToCwd(path) {
  return path.replace(`${process.cwd()}/`, '');
}

/**
 * The prologue, bound to one command's name.
 *
 * @param {string} tool the name the operator typed, e.g. 'galley-close'
 */
export function cli(tool) {
  /**
   * Exit with a message naming the tool. A script that needs stderr flushed
   * sets `process.exitCode` instead (see galley-close).
   *
   * @param {string} message
   * @returns {never}
   */
  function die(message) {
    console.error(`${tool}: ${message}`);
    process.exit(1);
  }

  /**
   * Resolve --local / --remote, or die explaining why there is no default.
   *
   * @param {{ local?: boolean, remote?: boolean }} flags
   * @returns {boolean} true for the local database
   */
  function resolveDatabase(flags) {
    try {
      return chooseDatabase(flags);
    } catch (err) {
      return die(err.message);
    }
  }

  /**
   * The post's source path, or die naming both shapes probed. A typo would
   * otherwise look like a quiet success (a 404 link, "no notes").
   *
   * @param {string} slug
   * @returns {string} absolute path to the .mdx
   */
  function requirePost(slug) {
    const path = resolvePostSource(slug);
    if (!path) {
      return die(
        `no post found for slug ${JSON.stringify(slug)} ` +
          `(looked for ${slug}.mdx and ${slug}/index.mdx)`,
      );
    }
    return path;
  }

  return { die, resolveDatabase, requirePost };
}
