// The assertion primitive and the two shapes almost every call takes, plus the
// small text helpers the checks are written in terms of.
//
// `passes` / `fails` live at module scope. ES modules are singletons, so every
// importer shares one tally without a context object being threaded through
// each phase — the same behaviour the counters had when this was one file.

const fails = [];
let passes = 0;

export function check(name, ok, detail = '') {
  if (ok) {
    passes++;
    return;
  }
  fails.push({ name, detail });
}

/**
 * Status assertion. `why` is appended to the standard `got <status>` detail,
 * for the cases where the status alone doesn't say what went wrong.
 */
export function checkStatus(name, res, expected, why = '') {
  check(name, res.status === expected, `got ${res.status}${why ? ` — ${why}` : ''}`);
}

/**
 * Substring-match a response header, reporting the actual value on failure.
 * A missing header reads as `(none)` rather than throwing, so the failure
 * points at the assertion.
 */
export function checkHeader(name, res, header, value) {
  const actual = res.headers.get(header) ?? '(none)';
  check(name, actual.includes(value), actual);
}

/** The tally so far. Read by the runtime diagnostics and the final report. */
export function results() {
  return { passes, fails, total: passes + fails.length };
}

export function printFailures(fs = fails) {
  for (const f of fs) console.error(`  ✗ ${f.name}${f.detail ? ` — ${f.detail}` : ''}`);
}

export function occurrences(haystack, needle) {
  let n = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    n++;
    i += needle.length;
  }
  return n;
}

// Strip // and /* */ comments so source-grep assertions match real code.
// Without this, a comment *explaining* that an identifier is deliberately
// absent trips the very check asserting its absence.
export function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
