// Per-post OG cards (finding 3.4).
//
// Every page used to share /og.png with the site-level description as its alt
// text, so sharing a post showed a generic identity card rather than the piece.
// This writes one 1200×630 card per post into dist/client/og/<slug>.png, and
// src/layouts/BlogPost.astro points og:image at it with the post title as alt.
//
// WHY A BUILD STEP AND NOT AN ENDPOINT. The obvious shape is a runtime
// /og/[slug].png.ts rendering through Satori, and it was not taken: Satori plus
// a WASM rasteriser plus embedded Fraunces/Inter binaries is a large addition to
// a worker whose entire point is being small, paid on a route that is fetched by
// scrapers rather than readers. sharp already ships with astro (it is astro's
// own image service), so this costs one build step and nothing at runtime. It is
// declared in package.json rather than leaned on transitively — same rule as
// js-yaml and @astrojs/markdown-remark, and pinned to what astro resolves.
//
// PUBLISHED POSTS ONLY. A card carries the post's title, and /og/<slug>.png is
// a guessable URL — so generating one for a scheduled draft would publish that
// draft's title to anyone who guessed the slug, which is exactly the disclosure
// the whole scheduled-publishing feature exists to prevent. (Cover images get
// away with being built ahead because astro:assets hash-names them.) A post
// therefore falls back to the generic /og.png until the deploy that follows its
// publication, which the authoring workflow produces anyway: step 5 sets the
// real date in a commit.
//
// THE LAYOUT ASKS THE SAME QUESTION AT THE SAME INSTANT, and that pairing is
// what makes the fallback above real rather than aspirational. BlogPost.astro
// links a card only when `isPublished(pubDate, __BUILD_TIME__)` — the build's
// own clock, inlined by Vite — because a post can go live between deploys with
// nothing regenerating this directory, and a per-request `isPublished` would
// then advertise a card that 404s. `npm run build` runs this script AFTER astro
// build, so this `now` is the later of the two and the advertised set can only
// be a subset of what gets written here.
//
// Fonts: this runs in Node, where the site's webfonts aren't installed. Same
// fallback as scripts/make-og.mjs — Georgia for serif, system-ui for sans, which
// is close enough at card sizes.
//
// Run by `npm run build`, after `astro build` (it writes into dist/client).
import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { listPostSlugs, readPost } from './content.mjs';
import { issue } from '../src/lib/edition.js';
import { isPublished } from '../src/lib/schedule.js';
import { readingTime } from '../src/lib/readingTime.js';

const OUT_DIR = resolve('dist/client/og');

const W = 1200;
const H = 630;
const PAD = 72;

// Approximate sRGB of the site's OKLCH tokens, as in scripts/make-og.mjs.
const BG = '#f6f2ec';
const TEXT = '#2a2520';
const MUTED = '#7d7369';
const ACCENT = '#8f5520';
const ACCENT_SURNAME = '#c97d3e';
const ACCENT_TAGLINE = '#7c512c';

const RULE_Y = 150;
const FOOTER_Y = H - PAD;
// The title block is centred in the space between the rule and the footer, so a
// two-line title doesn't sit high with a hole under it and a three-line one
// doesn't crowd the date.
const TITLE_BAND_TOP = RULE_Y + 40;
const TITLE_BAND_BOTTOM = FOOTER_Y - 60;

const dateFormatter = new Intl.DateTimeFormat('en-US', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  timeZone: 'UTC',
});

const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));

/**
 * Wrap a title to at most `maxLines` lines that fit `maxWidth`.
 *
 * Width is ESTIMATED, not measured: there is no font metrics engine here, and
 * loading one to place three lines of text would cost more than the error does.
 * 0.58em per character is measured off the rendered fallback (Georgia at
 * -0.03em tracking runs about 0.556em average) with headroom on top — the
 * estimate must err generous, because being wrong the other way puts the last
 * word over the card's right edge. The caller compensates by stepping the size
 * down until it fits, so the failure mode is a slightly small title.
 *
 * Returns null when this size won't hold the text — either because it needs
 * more than `maxLines` lines, or because one word is wider than a whole line.
 */
function wrap(text, fontSize, maxWidth, maxLines) {
  const perChar = fontSize * 0.58;
  const maxChars = Math.floor(maxWidth / perChar);
  const lines = [];
  let line = '';

  for (const word of text.split(/\s+/)) {
    // A word that cannot fit a line on its own will overflow wherever it lands,
    // so report failure and let the caller step the size down.
    //
    // This has to be checked BEFORE the line is assembled. Below, a word too
    // long for the current line becomes the new line unmeasured — so a title
    // whose longest word exceeds maxChars was returned as a "fitting" single
    // line and fitTitle took it at the FIRST rung, 72px, where the ladder that
    // exists to catch exactly this never ran at all. Any word of 26 characters
    // or more did it (maxChars is 25 at 72px), and the result was a valid PNG
    // with the title running off the right edge — which nothing downstream can
    // see, since smoke asserts the card exists and is over 1KB.
    if (word.length > maxChars) return null;

    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= maxChars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length > maxLines) return null;
  }
  if (line) lines.push(line);
  return lines.length <= maxLines ? lines : null;
}

/** Largest size in the ladder at which the title fits in 2–3 lines. */
function fitTitle(title) {
  const maxWidth = W - PAD * 2;
  for (const size of [72, 66, 60, 54, 48, 42, 38]) {
    const lines = wrap(title, size, maxWidth, 3);
    if (lines) return { size, lines };
  }
  // Nothing in the ladder fits — take the smallest and let it clip rather than
  // failing a build over a title nobody has written yet.
  return { size: 38, lines: wrap(title, 38, maxWidth, 3) ?? [title] };
}

function card({ title, pubDate, readLabel }) {
  const { size, lines } = fitTitle(title);
  const lineHeight = Math.round(size * 1.18);
  const { short } = issue(pubDate);

  const blockHeight = (lines.length - 1) * lineHeight;
  const centre = (TITLE_BAND_TOP + TITLE_BAND_BOTTOM) / 2;
  // y is a baseline, so shift down by roughly the cap height to centre the marks
  // rather than the baselines.
  const firstBaseline = Math.round(centre - blockHeight / 2 + size * 0.34);

  const titleTspans = lines
    .map((line, i) => `<text x="${PAD}" y="${firstBaseline + i * lineHeight}" class="title" fill="${TEXT}">${escapeXml(line)}</text>`)
    .join('\n  ');

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <style>
      .wordmark { font: 600 30px/1 'Fraunces', Georgia, serif; letter-spacing: -0.03em; }
      .issue    { font: 600 17px/1 'Inter', system-ui, sans-serif; letter-spacing: 0.14em; text-transform: uppercase; }
      .title    { font: 600 ${size}px/1.15 'Fraunces', Georgia, serif; letter-spacing: -0.03em; }
      .meta     { font: 400 22px/1 'Inter', system-ui, sans-serif; letter-spacing: 0.02em; }
      .domain   { font: italic 400 22px/1 'Fraunces', Georgia, serif; }
    </style>
  </defs>

  <rect width="${W}" height="${H}" fill="${BG}"/>

  <!-- the masthead conceit: wordmark and issue above one heavy rule -->
  <text x="${PAD}" y="${RULE_Y - 26}" class="wordmark" fill="${TEXT}">Matthew <tspan fill="${ACCENT_SURNAME}">Rossi</tspan></text>
  <text x="${W - PAD}" y="${RULE_Y - 28}" text-anchor="end" class="issue" fill="${ACCENT_TAGLINE}">${escapeXml(short)}</text>
  <rect x="${PAD}" y="${RULE_Y}" width="${W - PAD * 2}" height="2" fill="${TEXT}"/>

  ${titleTspans}

  <text x="${PAD}" y="${FOOTER_Y}" class="meta" fill="${MUTED}">${escapeXml(dateFormatter.format(pubDate))} · ${escapeXml(readLabel)}</text>
  <text x="${W - PAD}" y="${FOOTER_Y}" text-anchor="end" class="domain" fill="${ACCENT}">mjrossi.com</text>
</svg>`;
}

mkdirSync(OUT_DIR, { recursive: true });

let written = 0;
let skipped = 0;

for (const slug of listPostSlugs()) {
  const post = readPost(slug);
  if (!post) continue;

  if (!isPublished(post.pubDate)) {
    skipped++;
    continue;
  }

  const svg = card({
    title: String(post.data.title ?? slug),
    pubDate: post.pubDate,
    readLabel: readingTime(post.body).label,
  });

  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: false }).toBuffer();
  // A slug can contain a `/` — the loader's glob is `**`, so `a/b.mdx` is the
  // post `a/b` and its card is `og/a/b.png`. The mkdirSync above only makes
  // OUT_DIR itself, so the intermediate directory has to be made here or the
  // write throws ENOENT. 152e806 made listPostSlugs walk recursively for
  // exactly this shape and stopped one step short of writing it.
  //
  // Nested posts and BlogPost.astro's og:image URL agree without escaping: an
  // id is `/`-separated and the card path is built from the same string, so the
  // link and the file take the same shape.
  const target = resolve(OUT_DIR, `${slug}.png`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, png);
  written++;
}

console.log(
  `make-post-og: wrote ${written} card(s) to ${OUT_DIR}` +
  (skipped > 0 ? ` (${skipped} scheduled post(s) skipped — they use /og.png until they publish)` : ''),
);
