// Post-build smoke test. Checks static artifacts in dist/client and then spins
// up wrangler dev to hit every on-demand route. Focused on the handful of
// regressions that would be user-visible or hard to catch by eye — not every
// class name in the markup.
//
// Run after `npm run build` via `npm run smoke`. See CLAUDE.md, "Running smoke —
// read this before you debug a failure", before investigating a failure.
//
// This file is the SEQUENCE; the assertions live in scripts/smoke/. The order
// below is load-bearing and each step says why it sits where it does.
import { DIST, PUBLISHED_SLUG } from './smoke/config.mjs';
import { printFailures, results } from './smoke/check.mjs';
import { checkBuildArtifacts, checkSourceGuards, distExists } from './smoke/static.mjs';
import { checkWranglerConfig } from './smoke/wrangler.mjs';
import {
  checkExtendRoundTrip,
  clearFixtures,
  migrateLocalDb,
  seedLinks,
} from './smoke/fixtures.mjs';
import {
  RUNTIME_DIED_EXIT,
  reportRuntimeDiagnostics,
  startRuntime,
  stopRuntime,
  waitForReady,
} from './smoke/runtime.mjs';
import { checkEndpoints, checkRoutes } from './smoke/live-site.mjs';
import { checkHostUnlock, checkPreviewAndGalley } from './smoke/live-preview.mjs';

/** Bail before anything is spawned, for the conditions no assertion can survive. */
function die(message) {
  console.error(`smoke: ${message}`);
  process.exit(1);
}

/** Run a fatal setup step, naming what failed rather than dumping a stack. */
function setup(what, fn) {
  try {
    fn();
  } catch (err) {
    die(`${what}\n${err.message}`);
  }
}

if (!PUBLISHED_SLUG) die('no published post found — the published-link assertions cannot run');
if (!distExists()) die('dist/client not found — run `npm run build` first');

// ── before the runtime ─────────────────────────────
//
// Static checks run first so their failures are already recorded if wrangler
// never comes up — the error path prints them, and a missing generated config
// is both a failed check here and the reason `wrangler dev` can't resolve its
// redirected configuration.
checkSourceGuards();
checkWranglerConfig();
checkBuildArtifacts();

// D1 fixtures, all before the spawn: wrangler dev reads the persisted SQLite
// once at startup and never flushes back, so a row written after this point is
// invisible to the running worker.
setup('could not migrate the local database', migrateLocalDb);
setup('could not clear previous fixture rows', clearFixtures);
setup('could not seed preview_links fixtures', seedLinks);
// Needs the rows above, and runs before the spawn because it writes to the same
// database the worker is about to open.
setup('extendLink round-trip failed', checkExtendRoundTrip);

// ── the runtime ────────────────────────────────────

startRuntime();
let exitCode = 1;
try {
  await waitForReady();

  const routes = await checkRoutes();
  await checkPreviewAndGalley(routes);

  // Leave the local database as we found it, so a rerun asserts against a clean
  // table rather than accumulating rows from every previous run. Links included
  // — they are seeded before the spawn, so unlike the notes they DO survive to
  // the next run and would collide with the seeding INSERT. Best-effort: a stale
  // smoke row never affects production.
  //
  // Here rather than at the end because nothing after this point touches D1.
  try {
    clearFixtures();
  } catch {
    // ignored, deliberately
  }

  await checkHostUnlock();
  await checkEndpoints(routes);

  const { passes, fails, total } = results();
  if (fails.length === 0) {
    console.log(`smoke: PASS (${passes}/${total} checks)`);
    exitCode = 0;
  } else {
    console.error(`smoke: FAIL (${passes}/${total} checks, ${fails.length} failed)`);
    printFailures(fails);
    if (await reportRuntimeDiagnostics()) exitCode = RUNTIME_DIED_EXIT;
  }
} catch (err) {
  console.error(`smoke: ERROR — ${err.message}`);
  // Anything the static checks already found is the more useful diagnostic —
  // and is often the cause. A missing generated config, for instance, also
  // stops `wrangler dev` from resolving its redirected configuration, which
  // surfaces here as a bare readiness timeout unless the recorded failure is
  // printed alongside it.
  const { fails } = results();
  if (fails.length) {
    console.error(`smoke: ${fails.length} check(s) had already failed before this:`);
    printFailures(fails);
  }
  if (await reportRuntimeDiagnostics()) exitCode = RUNTIME_DIED_EXIT;
} finally {
  await stopRuntime();
  process.exit(exitCode);
}
