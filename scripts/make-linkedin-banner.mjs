// One-off regenerator for the LinkedIn banner: /card's front face at banner
// scale. Writes to git-ignored `out/`, never `public/`; regenerate when
// CARD_TAGLINE changes and re-upload by hand.
//
//   node scripts/make-linkedin-banner.mjs [out-dir]     (default: out/)
//
// IDENTITY ONLY, like the OG card: LinkedIn keeps the image indefinitely, so
// CARD_TAGLINE and no dated folio. PAPER ONLY: one image serves both LinkedIn
// themes; colours come from global.css via paper-tokens.mjs.
//
// It refuses to write a banner that breaks those rules, that puts text under
// the profile photo or in the phone app's cropped sides (checked on rendered
// pixels), or that substituted the Fraunces wordmark face. Still check an
// upload on desktop and phone: LinkedIn has no preview.
import sharp from 'sharp';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { CARD_TAGLINE, TAGLINE } from '../src/lib/identity.js';
import { paperTokens } from './paper-tokens.mjs';

// LinkedIn's recommended background-photo size, 4:1, plus a 2× render.
const W = 1584;
const H = 396;
const SCALES = [1, 2];
// LinkedIn's stated cap is 8 MB; some guidance says 3 MB. Warn above the lower.
const WARN_BYTES = 3 * 1024 * 1024;

// Where text must not go, in 1× pixels. The profile photo sits over roughly
// the left 40% of the lower half; the phone app crops the sides.
const PHOTO_ZONE = { left: 0, top: H / 2, right: W * 0.4, bottom: H };
const SIDE_CROP = 0.12;

const paper = paperTokens();
const BAND = paper.colour('--accent-band');
const BAND_BORDER = paper.colour('--accent-band-border');
const BG = paper.colour('--bg');
const TEXT = paper.colour('--text');
const SURNAME = paper.colour('--accent-surname');
const RULE = paper.colour('--accent-rule');
const TAGLINE_INK = paper.colour('--accent-tagline');
const GRAIN_OPACITY = paper.number('--grain-opacity');

const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));

// The family name of Google Fonts' static opsz-144 instance, the masthead's size.
const FRAUNCES = `'Fraunces', 'Fraunces 144pt'`;
const STYLE = `
  .folio   { font: 600 18px/1 'Inter', system-ui, sans-serif; letter-spacing: 0.18em; }
  .name    { font: 600 124px/1 ${FRAUNCES}, Georgia, serif; letter-spacing: -0.04em; }
  .tagline { font: italic 400 30px/1 ${FRAUNCES}, Georgia, serif; letter-spacing: 0.01em; }
  .probe   { font: 600 124px/1 ${FRAUNCES}; }
  .absent  { font: 600 124px/1 'no-such-family-at-all'; }`;

const FOLIO = ['LISBON, PORTUGAL', 'MJROSSI.COM'];
const svgDoc = (body, scale = 1) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W * scale}" height="${H * scale}" viewBox="0 0 ${W} ${H}"><defs><style>${STYLE}</style></defs>${body}</svg>`;

/** The rendered ink width of one line of text, in 1× pixels. */
async function inkWidth(cls, content) {
  const svg = svgDoc(`<text x="20" y="${H * 0.6}" class="${cls}">${content}</text>`);
  const { info } = await sharp(Buffer.from(svg)).trim().toBuffer({ resolveWithObject: true });
  return info.width;
}

// Layout, 1×. The block is centred on CX; everything below is measured.
const CX = 1000;
const FOLIO_Y = 120;
const NAME_Y = 246;
const TAGLINE_Y = 308;
const RULE_GAP = 22;

const fail = (msg) => { console.error(`make-linkedin-banner: ${msg}`); process.exit(1); };

// fontconfig substitutes silently (without Fraunces it picked Inter). A face
// as wide as a family that can't exist was substituted too.
if (await inkWidth('probe', 'Matthew Rossi') === await inkWidth('absent', 'Matthew Rossi')) {
  fail('Fraunces is not installed, so the wordmark would render in a substitute face. ' +
    'Install Fraunces (fonts.google.com/specimen/Fraunces) and run again.');
}

const nameWidth = await inkWidth('name', 'Matthew Rossi');
const taglineWidth = await inkWidth('tagline', escapeXml(CARD_TAGLINE));
// The hairlines run to the wordmark's edges, as the card's flex rules do.
const blockLeft = CX - nameWidth / 2;
const blockRight = CX + nameWidth / 2;
const ruleY = TAGLINE_Y - 9;

const textLayer = `
  <text x="${CX}" y="${FOLIO_Y}" text-anchor="middle" class="folio" fill="${TAGLINE_INK}">${FOLIO[0]}<tspan fill="${RULE}" dx="10">·</tspan><tspan fill="${TAGLINE_INK}" dx="10">${FOLIO[1]}</tspan></text>
  <text x="${CX}" y="${NAME_Y}" text-anchor="middle" class="name" fill="${TEXT}">Matthew <tspan fill="${SURNAME}">Rossi</tspan></text>
  <line x1="${blockLeft}" y1="${ruleY}" x2="${CX - taglineWidth / 2 - RULE_GAP}" y2="${ruleY}" stroke="${RULE}" stroke-width="1"/>
  <text x="${CX}" y="${TAGLINE_Y}" text-anchor="middle" class="tagline" fill="${TAGLINE_INK}">${escapeXml(CARD_TAGLINE)}</text>
  <line x1="${CX + taglineWidth / 2 + RULE_GAP}" y1="${ruleY}" x2="${blockRight}" y2="${ruleY}" stroke="${RULE}" stroke-width="1"/>`;

// The double rule along the foot, as under the masthead: a hairline, a gap of
// paper, then a heavier line.
const ground = `
  <rect width="${W}" height="${H}" fill="${BAND}"/>
  <rect x="0" y="${H - 5}" width="${W}" height="1" fill="${BAND_BORDER}"/>
  <rect x="0" y="${H - 4}" width="${W}" height="2" fill="${BG}"/>
  <rect x="0" y="${H - 2}" width="${W}" height="2" fill="${BAND_BORDER}"/>`;

// --- Refuse a banner that breaks the rules above. ---------------------------

if (!textLayer.includes(`>${escapeXml(CARD_TAGLINE)}<`)) fail('the tagline is not CARD_TAGLINE');
if (TAGLINE !== CARD_TAGLINE && textLayer.includes(escapeXml(TAGLINE))) fail('the banner carries TAGLINE, a fact about the present');
if (/Vol\.|No\.|\b20\d\d\b/.test(textLayer)) fail('the banner carries an edition or a date');

/** Every opaque pixel of the text layer must sit clear of both zones. */
async function checkZones(scale) {
  const { data, info } = await sharp(Buffer.from(svgDoc(textLayer, scale)))
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = Infinity, maxX = -Infinity;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * 4 + 3] === 0) continue;
      const ux = x / scale, uy = y / scale;
      if (ux < PHOTO_ZONE.right && uy >= PHOTO_ZONE.top) {
        fail(`text at (${Math.round(ux)}, ${Math.round(uy)}) sits under the profile photo`);
      }
      if (ux < minX) minX = ux;
      if (ux > maxX) maxX = ux;
    }
  }
  if (minX < W * SIDE_CROP || maxX > W * (1 - SIDE_CROP)) {
    fail(`text spans x ${Math.round(minX)}–${Math.round(maxX)}, outside the phone's side crop`);
  }
  return { minX, maxX };
}

// --- Render. -----------------------------------------------------------------

// Grain as on .masthead::before. Multiply at opacity a = multiply by
// 1 − a + a·n, so lift the tile toward white, then multiply fully.
async function grain(scale) {
  const tile = await sharp(readFileSync(resolve('public/noise.webp')))
    .resize(220 * scale, 220 * scale)
    .flatten({ background: '#ffffff' })
    .linear(GRAIN_OPACITY, 255 * (1 - GRAIN_OPACITY))
    .png()
    .toBuffer();
  return sharp({
    create: { width: W * scale, height: (H - 5) * scale, channels: 3, background: '#ffffff' },
  }).composite([{ input: tile, tile: true }]).png().toBuffer();
}

const outDir = resolve(process.argv[2] ?? 'out');
mkdirSync(outDir, { recursive: true });

// Every scale is checked before any file is written.
const spans = new Map();
for (const scale of SCALES) spans.set(scale, await checkZones(scale));

for (const scale of SCALES) {
  const { minX, maxX } = spans.get(scale);
  const out = await sharp(Buffer.from(svgDoc(ground, scale)))
    .composite([
      { input: await grain(scale), top: 0, left: 0, blend: 'multiply' },
      { input: Buffer.from(svgDoc(textLayer, scale)), top: 0, left: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();

  const name = scale === 1 ? 'linkedin-banner.png' : `linkedin-banner@${scale}x.png`;
  const path = join(outDir, name);
  writeFileSync(path, out);
  const kb = Math.round(out.length / 1024);
  console.log(`wrote ${path} (${W * scale}x${H * scale}, ${kb} KB; text x ${Math.round(minX)}–${Math.round(maxX)})`);
  if (out.length > WARN_BYTES) console.warn(`  over 3 MB — LinkedIn may refuse it; upload the 1× instead`);
}
