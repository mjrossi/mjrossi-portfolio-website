// One-off regenerator for public/og.png, the site's social card: the
// Broadsheet masthead at card scale. Fonts fall back to Georgia and system-ui.
//
//   node scripts/make-og.mjs public/og.png
import sharp from 'sharp';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CARD_TAGLINE, SET_IN } from '../src/lib/identity.js';

const W = 1200;
const H = 630;

// Palette — approximate sRGB of the site's OKLCH tokens, good enough
// for a downscaled OG card.
const BG = '#f6f2ec';
const BAND = '#f2e1c8';
const BAND_BORDER = '#d8be98';
const RULE = '#cbaf8b';
const ACCENT_TAGLINE = '#7c512c';   // --accent-tagline
const TEXT = '#2a2520';
const MUTED = '#7d7369';
const ACCENT = '#8f5520';
const ACCENT_SURNAME = '#b8702f';
const BORDER = '#dbd0c2';

const PAD = 72;
const BAND_H = 340;

// THE CARD STATES IDENTITY ONLY — NEVER A FACT ABOUT THE PRESENT. Scrapers
// cache by URL and never re-fetch, so an edition or a location is wrong the
// moment it moves (this card said Brooklyn for months after the site said
// Lisbon). Post cards may carry a date: it is the post's, and never moves.

// Avatar as a circle at the top-left of the band.
const AVATAR_SIZE = 112;
const AVATAR_X = PAD;
const AVATAR_Y = 72;

const avatarBuf = await sharp(resolve('src/assets/profile.jpg'))
  .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover' })
  .composite([{
    input: Buffer.from(
      `<svg width="${AVATAR_SIZE}" height="${AVATAR_SIZE}"><circle cx="${AVATAR_SIZE/2}" cy="${AVATAR_SIZE/2}" r="${AVATAR_SIZE/2 - 1}" fill="#fff" stroke="#d8be98" stroke-width="1"/></svg>`
    ),
    blend: 'dest-in',
  }])
  .png()
  .toBuffer();

// Escaping is the renderer's job; identity.js stores plain text.
const escapeXml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]
  ));

// Noise overlay — reuse the same texture the masthead uses at runtime.
const noiseBuf = readFileSync(resolve('public/noise.webp'));

// Layout constants — all measured from the band top, then body region below.
const NAME_X = PAD + AVATAR_SIZE + 32;
const NAME_Y_BASELINE = 168;              // baseline of "Matthew Rossi"
const RULE_Y = 250;                       // the rule under the name
const TAGLINE_Y = 282;                    // italic tagline below the rule
const QUOTE_Y = 462;                      // pull-quote line 1 baseline
const QUOTE_LH = 64;
const FOOTER_Y = 588;                     // footer baseline
const FOOTER_RULE_Y = FOOTER_Y - 38;

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <style>
      .name      { font: 600 86px/1 'Fraunces', Georgia, serif; letter-spacing: -0.04em; }
      .tagline   { font: italic 400 26px/1 'Fraunces', Georgia, serif; letter-spacing: 0.01em; }
      .quote     { font: italic 400 42px/1.25 'Fraunces', Georgia, serif; letter-spacing: -0.005em; }
      .footer-l  { font: italic 400 22px/1 'Fraunces', Georgia, serif; }
      .colophon  { font: italic 400 16px/1 'Fraunces', Georgia, serif; letter-spacing: 0.02em; }
    </style>
  </defs>

  <!-- cream page background -->
  <rect width="${W}" height="${H}" fill="${BG}"/>

  <!-- amber masthead band -->
  <rect x="0" y="0" width="${W}" height="${BAND_H}" fill="${BAND}"/>

  <!-- double rule under band (thin, gap, thicker) -->
  <rect x="0" y="${BAND_H}"     width="${W}" height="1" fill="${BAND_BORDER}"/>
  <rect x="0" y="${BAND_H + 3}" width="${W}" height="2" fill="${BAND_BORDER}"/>

  <!-- name: Matthew + accent Rossi -->
  <text x="${NAME_X}" y="${NAME_Y_BASELINE}" class="name" fill="${TEXT}">Matthew <tspan fill="${ACCENT_SURNAME}">Rossi</tspan></text>

  <!-- Long rule under name, inset from the padding -->
  <line x1="${PAD}" y1="${RULE_Y}" x2="${W - PAD}" y2="${RULE_Y}" stroke="${RULE}" stroke-width="1"/>

  <!-- tagline, centered under the rule -->
  <text x="${W/2}" y="${TAGLINE_Y}" text-anchor="middle" class="tagline" fill="${ACCENT_TAGLINE}">${escapeXml(CARD_TAGLINE)}</text>

  <!-- editorial pull quote in the lower half -->
  <text x="${PAD}" y="${QUOTE_Y}"              class="quote" fill="${TEXT}">Building at the intersection of software,</text>
  <text x="${PAD}" y="${QUOTE_Y + QUOTE_LH}"   class="quote" fill="${TEXT}">cities, and the streets in between.</text>

  <!-- footer divider rule -->
  <rect x="${PAD}" y="${FOOTER_RULE_Y}" width="${W - PAD * 2}" height="1" fill="${BORDER}"/>

  <!-- footer row: mjrossi.com · colophon -->
  <text x="${PAD}"     y="${FOOTER_Y}" class="footer-l" fill="${ACCENT}">mjrossi.com</text>
  <text x="${W/2}"     y="${FOOTER_Y}" text-anchor="middle" class="colophon" fill="${MUTED}">· ${escapeXml(SET_IN)} ·</text>
</svg>`;

// Compose: base SVG → tile noise.png across the band only (multiply) → drop avatar on top
const base = sharp(Buffer.from(svg));

// Tiled noise overlay constrained to the masthead band.
const noiseTile = await sharp(noiseBuf).resize(220, 220).png().toBuffer();
const noiseOverlay = await sharp({
  create: { width: W, height: BAND_H, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
})
  .composite([{ input: noiseTile, tile: true, blend: 'over' }])
  .ensureAlpha(0.30)
  .png()
  .toBuffer();

const out = await base
  .composite([
    { input: noiseOverlay, top: 0,        left: 0,        blend: 'multiply' },
    { input: avatarBuf,    top: AVATAR_Y, left: AVATAR_X },
  ])
  .png({ compressionLevel: 9, palette: false })
  .toBuffer();

writeFileSync(process.argv[2], out);
console.log(`wrote ${out.length} bytes to ${process.argv[2]} (${W}x${H})`);
