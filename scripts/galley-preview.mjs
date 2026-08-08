// The galley margin, rendered against fixtures, with no worker and no database.
//
//   just galley-preview            → serves it, prints the URL
//   just galley-preview --stale    → the same page, one revision behind the server
//   just galley-preview --shot out.png
//
// WHY THIS EXISTS. The galley's markers are the one part of this repo whose
// correctness is a rendering question, and nothing else here can see a pixel.
// The bug that prompted it: `.galley-marked` carried the inline highlighter-pen
// gradient — `linear-gradient(transparent 60%, …)` — which resolves against a
// LINE box on an inline element but against the whole PARAGRAPH box on the
// blocks the client actually marks. Every marked paragraph got a solid band
// across its last two lines, pointing with total confidence at prose no note
// was about. Unit tests cannot catch that. `npm run smoke` cannot catch that.
// A reviewer opening a real link catches it immediately, which is a slow and
// expensive way to find out.
//
// So: the whole margin, at a URL, in about a second. Getting there previously
// meant a build, a local D1 migration, `wrangler dev`, minting a link, and
// filing a note through the API before a single marker appeared on screen.
//
// NOTHING HERE IS A FIXTURE COPY OF PRODUCTION CODE, and that is the rule that
// keeps it honest. The stylesheet is read out of GalleyMargin.astro, the design
// tokens and post typography out of global.css, and the client is the real
// /scripts/galley.js loading the real /scripts/galley-quote.js. Only two things
// are fake: the prose, and a `fetch` stub standing in for /api/galley. If a
// marker looks wrong here it is wrong on mjrossi.com.
//
// Not a test — it asserts nothing and CI never runs it. It is the thing you
// look at before believing a change to the margin, in the same spirit as
// scripts/make-og.mjs: a local tool that renders something a human then judges.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import { cli } from './cli.mjs';

const { die } = cli('galley-preview');

const ROOT = resolve(import.meta.dirname, '..');
const PUBLIC = join(ROOT, 'public');

// Not 8788: that is `just preview` and `just smoke`, and a stale wrangler on it
// is a documented failure mode. Nothing should have to be killed to run this.
const DEFAULT_PORT = 8790;

const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

// ── argv ───────────────────────────────────────────────

let port = DEFAULT_PORT;
let shot = null;
let stale = false;

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '--port') {
    port = Number(argv[++i]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) die(`not a port: ${argv[i]}`);
  } else if (arg === '--shot') {
    shot = argv[++i];
    if (!shot) die('--shot needs a file to write');
  } else if (arg === '--stale') {
    stale = true;
  } else {
    die(
      `unknown argument: ${arg}\n` +
        '  usage: just galley-preview [--port N] [--shot FILE] [--stale]',
    );
  }
}

// ── the page ───────────────────────────────────────────

/**
 * The galley stylesheet, read out of the component that owns it.
 *
 * Copying these rules into this file would defeat the entire point: the bug
 * this tool exists to catch WAS a CSS rule, and a preview showing a different
 * rule than production ships is worse than no preview at all.
 */
async function galleyStyles() {
  const source = await readFile(join(ROOT, 'src/components/GalleyMargin.astro'), 'utf8');
  const match = /<style is:inline>([\s\S]*?)<\/style>/.exec(source);
  // Loud rather than silent: without the rules the page renders unstyled, which
  // reads as "the margin is broken" rather than "this tool is".
  if (!match) die('no `<style is:inline>` block in GalleyMargin.astro — has it been restructured?');
  return match[1];
}

/** Design tokens and `.post-body` typography, so the fixtures read like a real post. */
async function siteStyles() {
  return readFile(join(ROOT, 'src/styles/global.css'), 'utf8');
}

/**
 * The fixtures, chosen to be the cases that have actually gone wrong or could.
 *
 * `data-src` values are arbitrary here — there is no .mdx behind them — but
 * they have to be unique per block and match the notes below, exactly as
 * remark-source-anchors would emit them.
 */
const BLOCKS = `
  <p data-src="10-14">A reviewer selected the single word <b>congestion</b> in this paragraph and
  left a note on it. The paragraph runs several lines, which is ordinary for
  prose, and the marker has to sit on the word rather than on whatever text
  happens to fall at the bottom of the block.</p>

  <p data-src="16-19">A quote crossing inline markup: we shipped <a href="#">the Atlas</a> last
  spring, and the selected sentence spans three separate text nodes. Every post
  here has inline links and editors select whole sentences, so this is the
  normal case rather than the exotic one.</p>

  <p data-src="21-24">This paragraph carries a note whose quote is ambiguous, because the word note
  occurs more than once in it and nothing recorded says which note was meant. It
  falls back to the block marker rather than guessing.</p>

  <p data-src="26-26">A one-line paragraph with a note on <em>this phrase</em>.</p>

  <p data-src="28-28">A one-line paragraph whose note could not be placed at all.</p>

  <blockquote data-src="30-31"><p data-src="30-31">A pulled quote carrying a note, to check the block marker does not fight the
  blockquote's own rule.</p></blockquote>

  <ul>
    <li data-src="34-34">A list item with a note on <em>these words</em> here.</li>
    <li data-src="35-35">A list item whose note is stale — no marker at all, and no line number in
    the panel.</li>
  </ul>

  <p data-src="38-40">A paragraph with nothing filed against it, so the unmarked rhythm of the page
  stays visible for comparison. Without this it is hard to judge whether a
  marker is too loud.</p>
`;

let seq = 0;
function note(src, quote, body) {
  const [start, end] = src.split('-').map(Number);
  seq += 1;
  return {
    id: `preview-${seq}`,
    reviewer: seq % 3 === 0 ? 'mk' : 'jd',
    kind: 'comment',
    src_start: start,
    src_end: end,
    quote,
    body,
    suggestion: null,
    created_at: Date.now() - seq * 60000,
    // No `revision_hash`: the endpoint selects it and then strips it, folding it
    // into `stale` (see the `shape()` helper in api/galley.ts). Carrying it here
    // would put a field in the fixture that no real response has.
    stale: false,
  };
}

// The revision the SERVER is serving. Under `--stale` it differs from the
// `data-revision` on the page below, which is the whole point: that is the state
// a reviewer lands in when the draft is revised while their tab is open. Every
// marker must disappear — INCLUDING those for notes the server still considers
// current, since they were written against a source this document does not have
// — and the bar must raise the reload prompt. Without the flag the two agree,
// `pageStale` is permanently false, and deleting the gate from `markAnchors`
// changes nothing on screen.
const PAGE_REVISION = 'preview';
const SERVER_REVISION = stale ? 'preview-next' : PAGE_REVISION;

/** Canned `GET /api/galley` payload. Shapes mirror src/pages/api/galley.ts exactly. */
const PAYLOAD = {
  slug: 'galley-preview',
  reviewer: 'jd',
  revision: SERVER_REVISION,
  notes: [
    note('10-14', 'congestion', 'Is this the term we want, or is it jargon here?'),
    note('16-19', 'we shipped the Atlas last spring', 'Date this — "last spring" ages badly.'),
    note('21-24', 'note', 'Ambiguous quote: must fall back to the block.'),
    note('26-26', 'this phrase', 'Short block, precise marker.'),
    note('28-28', 'a quote that is nowhere in the block', 'Unplaceable: block marker.'),
    note('30-31', "does not fight the blockquote's own rule", 'Reads fine.'),
    note('34-34', 'these words', 'Marker inside a list item.'),
    // Two notes on one block: one placeable, one not. The count must read 1 —
    // it stands for what the BLOCK marker covers, not for notes on the block.
    note('21-24', 'occurs more than once', 'This one places precisely.'),
    // Stale: written against an earlier revision, so no marker anywhere and an
    // `earlier revision` chip in place of the line number.
    { ...note('35-35', 'no marker at all', 'Filed before the last revision.'), stale: true },
  ],
  closed: [note('10-14', 'ordinary for prose', 'Raised last round; already addressed.')],
};

async function page() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Galley preview — fixtures, no worker, no database</title>
<style>${await siteStyles()}</style>
<style>${await galleyStyles()}</style>
<style>
  /* Preview chrome only. Never shipped — a real post gets this from Base.astro. */
  .preview-note {
    max-width: 780px;
    margin: 0 auto;
    padding: 2rem var(--pad) 0;
    font-family: var(--font-ui);
    font-size: 0.78rem;
    color: var(--muted);
  }
  .preview-note code { font-size: 0.9em; }
</style>
</head>
<body>
  <div class="preview-note">
    Fixtures — no worker, no database. Styles come from <code>GalleyMargin.astro</code> and
    <code>global.css</code>; the client is the real <code>/scripts/galley.js</code>. Select any
    passage to exercise the composer.
    ${
      stale
        ? '<strong>--stale:</strong> the server is a revision ahead of this page. Expect no markers ' +
          'anywhere, no highlights, the reload prompt in the bar, and a refused save.'
        : ''
    }
  </div>
  <article class="page post">
    <div class="post-body">${BLOCKS}</div>
  </article>

  <script>
    // Stands in for /api/galley. Classic (non-module) script so it runs BEFORE
    // the deferred module below, which fires its first GET on load.
    (() => {
      const payload = ${JSON.stringify(PAYLOAD)};
      const real = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const url = String(input && input.url ? input.url : input);
        if (!url.includes('/api/galley')) return real(input, init);
        // POST: accept the note and fold it into the list, so leaving one from
        // the composer behaves the way it does against the real endpoint.
        if (init && init.method === 'POST') {
          const sent = JSON.parse(init.body);
          // The endpoint refuses a note echoing a revision it no longer holds,
          // so under --stale the composer must show its stale_page message and
          // KEEP the typed text. That path is otherwise unreachable by hand.
          if (sent.revision !== payload.revision) {
            return Promise.resolve(
              new Response('{"error":"stale_page"}', {
                status: 409,
                headers: { 'Content-Type': 'application/json' },
              }),
            );
          }
          const [start, end] = String(sent.src || '0-0').split('-').map(Number);
          payload.notes.push({
            id: 'preview-' + (payload.notes.length + 1),
            reviewer: payload.reviewer,
            kind: sent.kind,
            src_start: start,
            src_end: end,
            quote: sent.quote,
            body: sent.body,
            suggestion: sent.suggestion || null,
            created_at: Date.now(),
            stale: false,
          });
          return Promise.resolve(new Response('{"ok":true}', { status: 200 }));
        }
        return Promise.resolve(
          new Response(JSON.stringify(payload), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        );
      };
    })();
  </script>

  <div id="galley" data-slug="galley-preview" data-reviewer="jd" data-revision="${PAGE_REVISION}"></div>
  <script type="module" src="/scripts/galley.js"></script>
</body>
</html>`;
}

// ── serve ──────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(await page());
    return;
  }

  // Everything else comes out of public/, which is what puts the real client at
  // the real path — /scripts/galley.js importing ./galley-quote.js resolves
  // exactly as it does on the deployed site.
  const asked = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, asked);
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end('nope');
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

server.listen(port, '127.0.0.1', async () => {
  // The token is never verified — nothing here checks a signature — but it has
  // to be PRESENT, because galley.js reads it from the query string and returns
  // early without one. Same for data-slug on the mount.
  const url = `http://127.0.0.1:${port}/?preview=preview`;
  process.stderr.write(`galley-preview: ${url}${stale ? '  (--stale: page one revision behind)' : ''}\n`);

  if (!shot) {
    process.stderr.write('  ctrl-c to stop\n');
    return;
  }
  const ok = await screenshot(url, shot);
  server.close();
  if (!ok) die(`could not find a headless browser to write ${shot}`);
  process.stderr.write(`galley-preview: wrote ${shot}\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') die(`port ${port} is busy — pass --port N`);
  die(err.message);
});

/**
 * Best-effort headless screenshot.
 *
 * Chrome is not a dependency of this repo and must not become one — the same
 * argument that keeps Puppeteer out for the diagrams. If it happens to be
 * installed the shot is free; if not, the server is still the answer.
 */
async function screenshot(url, out) {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    'google-chrome',
    'chromium',
  ];
  for (const bin of candidates) {
    const code = await run(bin, [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      // The client renders on load and again on fetch; without a budget the
      // shot lands on an empty margin.
      '--virtual-time-budget=4000',
      '--window-size=900,1400',
      `--screenshot=${resolve(out)}`,
      url,
    ]);
    if (code === 0) return true;
  }
  return false;
}

function run(bin, args) {
  return new Promise((done) => {
    const child = spawn(bin, args, { stdio: 'ignore' });
    child.on('error', () => done(1));
    child.on('exit', (code) => done(code));
  });
}
