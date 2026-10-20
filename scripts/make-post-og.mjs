// Per-post OG cards: one 1200×630 PNG per post in dist/client/og/<slug>.png,
// which BlogPost.astro uses as og:image with the title as alt. Run by
// `npm run build`, after `astro build`.
//
// A build step, not a Satori endpoint: that would put a WASM rasteriser and
// font binaries into a worker meant to be small, for a route only scrapers
// fetch. sharp is a direct dependency, pinned to what astro resolves.
//
// PUBLISHED POSTS ONLY. /og/<slug>.png is guessable, so a draft's card would
// leak its title. A post uses /og.png until the next deploy after it goes live.
// BlogPost.astro asks the same question with `__BUILD_TIME__`, not the request
// clock, and this runs after astro build, so it never links a card this skipped.
//
// Fonts fall back to Georgia and system-ui, as in make-og.mjs.
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
const ACCENT_SURNAME = '#b8702f';
const ACCENT_TAGLINE = '#7c512c';

const RULE_Y = 150;
const FOOTER_Y = H - PAD;
// Centred between the rule and the footer, so two or three lines both sit right.
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
 * Wrap a title to at most `maxLines` lines that fit `maxWidth`, or null.
 *
 * Width is ESTIMATED at 0.58em a character (Georgia averages ~0.556em), erring
 * generous: wrong the other way runs the last word off the edge. The caller
 * steps the size down until it fits.
 */
function wrap(text, fontSize, maxWidth, maxLines) {
  const perChar = fontSize * 0.58;
  const maxChars = Math.floor(maxWidth / perChar);
  const lines = [];
  let line = '';

  for (const word of text.split(/\s+/)) {
    // Checked BEFORE assembling the line: an over-long word used to become a
    // line unmeasured and "fit" at 72px, running off the edge where nothing
    // downstream could see it (smoke only checks the PNG exists).
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
  // Nothing fits: take the smallest and clip, rather than fail the build.
  return { size: 38, lines: wrap(title, 38, maxWidth, 3) ?? [title] };
}

function card({ title, pubDate, readLabel }) {
  const { size, lines } = fitTitle(title);
  const lineHeight = Math.round(size * 1.18);
  const { short } = issue(pubDate);

  const blockHeight = (lines.length - 1) * lineHeight;
  const centre = (TITLE_BAND_TOP + TITLE_BAND_BOTTOM) / 2;
  // y is a baseline: shift by roughly the cap height to centre the marks.
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
  // A slug can contain `/` (the glob is `**`), so make the subdirectory. The
  // og:image URL is built from the same id, so the two agree without escaping.
  const target = resolve(OUT_DIR, `${slug}.png`);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, png);
  written++;
}

console.log(
  `make-post-og: wrote ${written} card(s) to ${OUT_DIR}` +
  (skipped > 0 ? ` (${skipped} scheduled post(s) skipped — they use /og.png until they publish)` : ''),
);
