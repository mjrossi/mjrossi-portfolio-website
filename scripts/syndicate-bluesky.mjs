#!/usr/bin/env node
// Post a single new blog post to Bluesky via the AT Protocol.
//
// Invoked by .github/workflows/syndicate.yml once per MDX file that was
// *added* in a push to main. See CLAUDE.md "Syndication" for the full flow.
//
//   node scripts/syndicate-bluesky.mjs <path-to-mdx> [--dry-run]
//
// Env (required unless --dry-run):
//   BLUESKY_IDENTIFIER     handle, e.g. "mjrossi.com" or "<user>.bsky.social"
//   BLUESKY_APP_PASSWORD   Bluesky Settings -> App Passwords (revocable)

import { readFileSync } from 'node:fs';
import { argv, env, exit } from 'node:process';

const SITE = 'https://mjrossi.com';
const BLOG_BASE = 'src/content/blog/';
const PDS = 'https://bsky.social';
const MAX_GRAPHEMES = 300;
const READY_TIMEOUT_MS = 10 * 60 * 1000;
const INITIAL_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 60_000;

function die(msg) {
  console.error(`syndicate-bluesky: ${msg}`);
  exit(1);
}

function parseArgs(rawArgv) {
  const args = rawArgv.slice(2);
  const dryRun = args.includes('--dry-run');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) die('usage: syndicate-bluesky.mjs <path-to-mdx> [--dry-run]');
  return { file, dryRun };
}

// Mirrors src/content.config.ts `generateId`: strip the trailing `/index.mdx`
// or `.mdx` to get the slug. Kept in sync by convention — if generateId
// changes, this must too (covered by the dry-run verification step).
function deriveSlug(path) {
  if (!path.startsWith(BLOG_BASE)) {
    die(`expected path under ${BLOG_BASE}, got: ${path}`);
  }
  const rel = path.slice(BLOG_BASE.length);
  const slug = rel.replace(/(?:\/index)?\.mdx?$/, '');
  if (!slug || slug === 'index') {
    die(`could not derive slug from: ${path}`);
  }
  return slug;
}

// Zod (src/content.config.ts) already enforces the frontmatter shape at
// build time, so we trust the format and only pull the two fields we need.
function parseFrontmatter(source) {
  const m = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) die('no YAML frontmatter found');
  const body = m[1];
  const pull = (key) => {
    const r = new RegExp(`^${key}:\\s*(.+)$`, 'm');
    const mm = body.match(r);
    if (!mm) die(`frontmatter missing "${key}"`);
    let v = mm[1].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    return v;
  };
  return { title: pull('title'), description: pull('description') };
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function graphemeLength(s) {
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

function truncateToGraphemes(s, limit) {
  if (graphemeLength(s) <= limit) return s;
  let out = '';
  let n = 0;
  for (const seg of segmenter.segment(s)) {
    if (n + 1 > limit) break;
    out += seg.segment;
    n++;
  }
  return out;
}

// AT Protocol facets index into the UTF-8 byte representation of `text`,
// not the JS string. Compute byteStart by encoding the prefix that precedes
// the URL; byteEnd = byteStart + UTF-8 length of the URL itself.
function composeSkeet({ title, description, url }) {
  const sep = '\n\n';
  const titleLen = graphemeLength(title);
  const urlLen = graphemeLength(url);
  const sepLen = graphemeLength(sep);
  const base = `${title}${sep}${description}${sep}${url}`;
  let finalDescription = description;
  let skipDesc = false;

  if (graphemeLength(base) > MAX_GRAPHEMES) {
    const overhead = titleLen + sepLen + sepLen + urlLen + 1;
    const budget = MAX_GRAPHEMES - overhead;
    if (budget <= 0) {
      const noDesc = `${title}${sep}${url}`;
      if (graphemeLength(noDesc) > MAX_GRAPHEMES) {
        die('title + URL alone exceeds 300 graphemes — cannot syndicate');
      }
      skipDesc = true;
      finalDescription = '';
    } else {
      finalDescription = truncateToGraphemes(description, budget) + '…';
    }
  }

  const text = skipDesc
    ? `${title}${sep}${url}`
    : `${title}${sep}${finalDescription}${sep}${url}`;
  const prefix = skipDesc
    ? `${title}${sep}`
    : `${title}${sep}${finalDescription}${sep}`;
  const encoder = new TextEncoder();
  const byteStart = encoder.encode(prefix).length;
  const byteEnd = byteStart + encoder.encode(url).length;
  const facets = [
    {
      index: { byteStart, byteEnd },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }],
    },
  ];
  return { text, facets };
}

async function waitForUrl(url) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let delay = INITIAL_BACKOFF_MS;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    let status = 'error';
    try {
      const res = await fetch(url, { method: 'GET', redirect: 'manual' });
      status = String(res.status);
      if (res.status === 200) {
        console.log(`URL ready after ${attempt} attempt(s): ${url}`);
        return;
      }
    } catch (e) {
      status = e.message;
    }
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining <= 0) break;
    const sleep = Math.min(delay, remaining);
    console.log(
      `attempt ${attempt}: ${status} — retrying in ${Math.round(sleep / 1000)}s`,
    );
    await new Promise((r) => setTimeout(r, sleep));
    delay = Math.min(delay * 2, MAX_BACKOFF_MS);
  }
  die(
    `URL never returned 200 within ${READY_TIMEOUT_MS / 60_000} minutes: ${url}`,
  );
}

async function blueskyLogin(identifier, password) {
  const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier, password }),
  });
  if (!res.ok) {
    const body = await res.text();
    die(`Bluesky login failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function blueskyCreatePost({ did, accessJwt, text, facets }) {
  const record = {
    $type: 'app.bsky.feed.post',
    text,
    facets,
    createdAt: new Date().toISOString(),
    langs: ['en'],
  };
  const res = await fetch(`${PDS}/xrpc/com.atproto.repo.createRecord`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessJwt}`,
    },
    body: JSON.stringify({
      repo: did,
      collection: 'app.bsky.feed.post',
      record,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    die(`Bluesky createRecord failed (${res.status}): ${body}`);
  }
  return res.json();
}

async function main() {
  const { file, dryRun } = parseArgs(argv);
  const source = readFileSync(file, 'utf8');
  const { title, description } = parseFrontmatter(source);
  const slug = deriveSlug(file);
  const url = `${SITE}/blog/${slug}/`;
  const { text, facets } = composeSkeet({ title, description, url });

  const byteLen = new TextEncoder().encode(text).length;
  console.log('--- skeet preview ---');
  console.log(text);
  console.log('--- facets ---');
  console.log(JSON.stringify(facets, null, 2));
  console.log(
    `--- ${graphemeLength(text)} graphemes / ${byteLen} bytes / limit ${MAX_GRAPHEMES} graphemes ---`,
  );

  if (dryRun) {
    console.log('dry run: skipping URL poll and Bluesky API calls');
    return;
  }

  const identifier = env.BLUESKY_IDENTIFIER;
  const password = env.BLUESKY_APP_PASSWORD;
  if (!identifier) die('BLUESKY_IDENTIFIER env var not set');
  if (!password) die('BLUESKY_APP_PASSWORD env var not set');

  console.log(`waiting for ${url} to return 200...`);
  await waitForUrl(url);

  console.log('logging into Bluesky...');
  const session = await blueskyLogin(identifier, password);

  console.log('posting...');
  const result = await blueskyCreatePost({
    did: session.did,
    accessJwt: session.accessJwt,
    text,
    facets,
  });
  console.log(`posted: ${result.uri}`);
}

main().catch((e) => die(e.stack || String(e)));
