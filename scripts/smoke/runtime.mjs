// Owning `wrangler dev`: starting it, waiting for it, telling whether it died,
// and shutting it down.
//
// `wrangler dev` can exit in the middle of a run. When it does, every fetch
// after that point either 500s or is refused outright, and each one lands as a
// named assertion failure — so the report blames the checks that happened to be
// in flight rather than the runtime that vanished underneath them. A CI failure
// on this suite once read as four galley violations, including "a valid token
// wrote to a post it was not minted for", when in fact the worker had already
// died and no token had written anything. So: watch the process, and on any
// failure say what happened to it.
//
// This is not a flake to be tolerated. See CLAUDE.md, "wrangler dev died
// mid-run, and smoke exited 75" — the cause is a handler returning without
// draining a request body it was sent, and `refuse` in src/lib/server.ts is the
// fix. Do not re-add the CI retry that was briefly here; it failed twice in a
// row anyway.
import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { results } from './check.mjs';
import { ACCESS_ARGS } from './access.mjs';
import { BASE, PORT, PREVIEW_KEY_ARGS, READY_TIMEOUT_MS } from './config.mjs';

/** Exit code for "the runtime died", as distinct from "an assertion failed" (1). */
export const RUNTIME_DIED_EXIT = 75; // EX_TEMPFAIL

const WRANGLER_TAIL_LINES = 40;
// Counted in log ENTRIES rather than lines — see tailWranglerLog. Generous,
// deliberately: wrangler's own log file carries debug entries the console never
// shows at --log-level warn, and it is the only place the cause of a mid-run
// exit is written down. This prints on a failure that has so far only ever
// happened in CI, where there is no second chance to go and look.
const WRANGLER_LOG_TAIL_ENTRIES = 60;

let wrangler = null;
const wranglerOutput = [];
let wranglerLogPath = null;
let wranglerExit = null;
// Set once waitForReady has seen the runtime answer. Load-bearing for the exit
// code: a runtime that came up and then vanished is the upstream crash, but one
// that NEVER came up is a real, reproducible failure — a stale generated config,
// port 8788 already held by an orphaned run.
let wranglerWasReady = false;

function absorbWranglerOutput(chunk, forward) {
  const text = chunk.toString();
  if (forward) process.stderr.write(text);
  // wrangler prints this once, naming a file that holds far more than it puts
  // on the console. Scraped rather than reconstructed because the directory is
  // platform-dependent (~/Library/Preferences here, ~/.config in CI).
  const logged = text.match(/Logs were written to "([^"]+)"/);
  if (logged) wranglerLogPath = logged[1];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    wranglerOutput.push(line);
    if (wranglerOutput.length > WRANGLER_TAIL_LINES) wranglerOutput.shift();
  }
}

export function startRuntime() {
  wrangler = spawn(
    'npx',
    [
      'wrangler', 'dev', '--port', String(PORT), '--ip', '127.0.0.1', '--log-level', 'warn',
      ...PREVIEW_KEY_ARGS,
      // The Access key set the Desk checks sign against, replacing the fetch to
      // Cloudflare's certs endpoint for the length of this run. Always injected
      // — wrangler.jsonc's real values are placeholders, and smoke.mjs refuses
      // to start if .dev.vars would shadow these. See scripts/smoke/access.mjs.
      ...ACCESS_ARGS,
    ],
    // Both streams are piped so a runtime that dies mid-run can be told apart
    // from an assertion that genuinely failed. stderr is still forwarded live,
    // so ordinary output is unchanged; stdout is buffered and only printed when
    // something has gone wrong, since `--log-level warn` makes it empty on a
    // healthy run.
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  wrangler.stdout.on('data', (chunk) => absorbWranglerOutput(chunk, false));
  wrangler.stderr.on('data', (chunk) => absorbWranglerOutput(chunk, true));
  // Recorded rather than acted on. Tearing the run down here would lose the
  // assertions still to come, and on a healthy run this fires during the SIGTERM
  // in stopRuntime, where it means nothing.
  //
  // This handler is a best case, not the mechanism. The child is `npx`, which
  // wraps two more processes before workerd, so a runtime that dies need not take
  // the handle with it — and `process.exit()` can outrun the event even when it
  // does. Verified: killing the middle process mid-run left this silent while
  // every remaining fetch was refused. Hence the two topology-independent reads
  // in reportRuntimeDiagnostics.
  wrangler.on('exit', (code, signal) => {
    wranglerExit = { code, signal, afterChecks: results().total };
  });
  return wrangler;
}

export async function waitForReady() {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/`, { redirect: 'manual' });
      if (res.status) {
        wranglerWasReady = true;
        return;
      }
    } catch {
      // server not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`smoke: wrangler dev did not become ready within ${READY_TIMEOUT_MS}ms`);
}

/** Did anything answer on the port? The one check that survives any topology. */
async function runtimeIsListening() {
  try {
    await fetch(`${BASE}/`, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  }
}

/**
 * Reports what became of the runtime. Returns whether it died, which the caller
 * turns into RUNTIME_DIED_EXIT so a crash is distinguishable from a failed
 * assertion by exit code alone.
 */
export async function reportRuntimeDiagnostics() {
  // `exitCode`/`signalCode` are set on the handle as soon as the child is
  // reaped, so they read true even when the 'exit' event never got delivered.
  const exit =
    wranglerExit ??
    (wrangler && (wrangler.exitCode !== null || wrangler.signalCode !== null)
      ? { code: wrangler.exitCode, signal: wrangler.signalCode, afterChecks: null }
      : null);
  const listening = await runtimeIsListening();
  // "Died" means it was serving and then stopped. Never having started is a
  // different failure with a different exit code — see wranglerWasReady.
  const died = wranglerWasReady && (Boolean(exit) || !listening);

  if (died) {
    const where = exit?.afterChecks !== null && exit?.afterChecks !== undefined
      ? `, after ${exit.afterChecks} check(s)`
      : '';
    console.error(
      exit
        ? `smoke: wrangler dev EXITED MID-RUN — code ${exit.code}, signal ${exit.signal}${where}.`
        : 'smoke: wrangler dev is NOT ANSWERING on ' + BASE +
            ' — the runtime died without the process handle noticing.',
    );
    console.error(
      '  The failures above are collateral of that, not assertions the code ' +
        'actually violated. Debug the runtime, not the checks.',
    );
    console.error(
      `  Exiting ${RUNTIME_DIED_EXIT} rather than 1. The cause to look for ` +
        'first is a handler that returns without reading a request body it ' +
        'was sent — wrangler dev is left holding the stream and eventually ' +
        'drops the connection. See `refuse` in src/lib/server.ts.',
    );
  }
  if (wranglerOutput.length) {
    console.error(`smoke: last ${wranglerOutput.length} line(s) of wrangler output:`);
    for (const line of wranglerOutput) console.error(`  | ${line}`);
  }
  // Only when the runtime actually went down. On an ordinary assertion failure
  // this file says nothing the checks didn't, and it is long.
  if (died && wranglerLogPath && existsSync(wranglerLogPath)) {
    try {
      console.error(`smoke: tail of ${wranglerLogPath}:`);
      for (const line of tailWranglerLog(readFileSync(wranglerLogPath, 'utf8'))) {
        console.error(`  | ${line}`);
      }
    } catch (err) {
      console.error(`smoke: could not read ${wranglerLogPath} — ${err.message}`);
    }
  }
  return died;
}

/**
 * The log is a series of `--- <ISO timestamp> <level>` entries terminated by a
 * bare `---`. A plain line tail is useless on it: startup logs the entire
 * bundled worker, one quoted source line at a time, which buried the actual
 * error under 200,000 characters of Astro's client JS the first time this ran
 * in CI. So elide the body of any entry long enough to be one of those dumps,
 * and keep the entries themselves — the error and the stack that follows it are
 * short, and it is the sequence of entries either side that says what happened.
 *
 * @param {string} text
 */
function tailWranglerLog(text) {
  const HEADER = /^--- \d{4}-\d{2}-\d{2}T[\d:.]+Z \w+$/;
  // Head AND tail, because the two ends carry different halves of the answer
  // and a long entry has both. wrangler's fatal entry opens with the message
  // and the stack and CLOSES with the `cause` — the only place the underlying
  // error is named — so a head-only elision drops precisely the line worth
  // printing. Learned by eliding it in CI and having to go back for it.
  const ENTRY_HEAD_LINES = 20;
  const ENTRY_TAIL_LINES = 12;
  const MAX_ENTRY_LINES = ENTRY_HEAD_LINES + ENTRY_TAIL_LINES;
  const entries = [];
  let current = null;
  for (const line of text.split('\n')) {
    if (HEADER.test(line)) {
      current = [line];
      entries.push(current);
    } else if (line.trim() === '---') {
      current = null;
    } else if (current && line.trim()) {
      current.push(line);
    }
  }
  const out = [];
  for (const entry of entries.slice(-WRANGLER_LOG_TAIL_ENTRIES)) {
    if (entry.length > MAX_ENTRY_LINES) {
      out.push(...entry.slice(0, ENTRY_HEAD_LINES));
      out.push(`      … ${entry.length - MAX_ENTRY_LINES} line(s) elided …`);
      out.push(...entry.slice(-ENTRY_TAIL_LINES));
    } else {
      out.push(...entry);
    }
  }
  return out;
}

export async function stopRuntime() {
  if (!wrangler) return;
  wrangler.kill('SIGTERM');
  await new Promise((r) => {
    wrangler.once('exit', r);
    setTimeout(() => {
      wrangler.kill('SIGKILL');
      r();
    }, 3000);
  });
}
