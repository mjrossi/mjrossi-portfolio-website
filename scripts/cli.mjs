// The four lines every operator script was writing for itself.
//
// Six commands (preview-link, preview-extend, preview-roster, galley-pull,
// galley-close, galley-reopen) each opened with the same prologue: a `die` that
// prefixes stderr with the tool's own name, a try/catch around chooseDatabase
// that turns its throw back into a die, and — for the three that name a post — a
// resolvePostSource guard. That is not a lot of code, but it was SEVEN copies of
// `die` and SIX of the try/catch, and the failure mode of a copy is that it
// drifts: one script's guard already carried a better message than the other
// two's, which is the direction this always goes.
//
// WHY A FACTORY rather than free functions taking a prefix. `die` is called
// dozens of times per script and every one of those call sites reads better bare,
// so the tool name is bound once at the top and the rest of the file is unchanged:
//
//   const { die, resolveDatabase, requirePost } = cli('galley-close');
//
// WHAT DOES NOT LIVE HERE, deliberately: argv parsing. Each script's flag loop
// looks alike from a distance and is not alike up close — every one of them
// carries refusal messages written for that command's specific mistake (`--hours
// 0` is a revoke wearing the wrong name; `--all` with a slug; a reviewer label
// that cannot be signed), and those messages are the most useful thing in the
// file. A spec-driven parser general enough to keep them would be larger than the
// six loops it replaced, and nothing in this repo executes these scripts under
// test, so the drift would be silent. See CLAUDE.md on the operator surface.

import { chooseDatabase } from './database-target.mjs';
import { resolvePostSource } from './content.mjs';

/**
 * Strip the working directory off an absolute path, so output names the file
 * the way the operator would type it.
 *
 * Not bound to a tool, so it stands alone: every script that prints a path wants
 * this, and a path is a path.
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
   * Fail with a message naming the tool that failed.
   *
   * `process.exit` rather than `throw`: these are top-level scripts, and a stack
   * trace above an operator error is noise around the one line that matters.
   * Note that this is the EXIT path — a script that needs stderr flushed and a
   * non-zero code without dying (galley-close, on "nothing closed") sets
   * `process.exitCode` itself instead. See the note at the end of that file.
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
   * chooseDatabase THROWS rather than exiting precisely so this wrapper can
   * exist: the message it composes is long and general, and prefixing it with
   * the tool the operator actually ran is what makes it land. See
   * scripts/database-target.mjs.
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
   * The post's source path, or die naming both shapes that were probed.
   *
   * Validated against real content because a typo otherwise produces a
   * confident, wrong-looking success: preview-link mints a valid link that 404s,
   * galley-pull reports "no notes" for a post that has plenty, and galley-close
   * reports "no notes to close" — which reads exactly like the round already
   * being closed.
   *
   * The message names `<slug>.mdx` AND `<slug>/index.mdx` because those are the
   * two places resolvePostSource looked, and a post that has just gained a
   * colocated image has moved between them. preview-link.mjs already said this;
   * galley-close and galley-reopen said only "no post found", and there was no
   * reason for the difference beyond which file was written first.
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
