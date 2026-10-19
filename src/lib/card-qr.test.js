import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import jsQR from 'jsqr';

import { QR_URL, QR_QUIET, QR_SIZE, QR_PATH } from './card-qr.js';

// Decoded, not eyeballed. The QR code is generated once and committed, so the
// failure this guards is a regeneration (or a hand edit) that still LOOKS like
// a QR code — the one kind of wrong nobody holding a phone up would see first.

const PX = 8; // pixels per module

async function rasterise() {
  // The page's own drawing: a light tile across the whole viewBox, quiet zone
  // included, with the path filled dark on top of it.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${QR_SIZE * PX}" height="${QR_SIZE * PX}" viewBox="0 0 ${QR_SIZE} ${QR_SIZE}" shape-rendering="crispEdges">
    <rect width="${QR_SIZE}" height="${QR_SIZE}" fill="#fff"/>
    <path d="${QR_PATH}" fill="#000"/>
  </svg>`;
  const { data, info } = await sharp(Buffer.from(svg))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data), width: info.width, height: info.height };
}

test('the card QR decodes to https://mjrossi.com/card', async () => {
  const { data, width, height } = await rasterise();
  const code = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
  assert.ok(code, 'jsQR found no code');
  assert.equal(code.data, 'https://mjrossi.com/card');
  assert.equal(QR_URL, 'https://mjrossi.com/card');
});

test('the card QR keeps a quiet zone of at least 4 modules', () => {
  assert.ok(QR_QUIET >= 4);
  let min = Infinity;
  let max = -Infinity;
  for (const [, x, y, w] of QR_PATH.matchAll(/M(\d+) (\d+)h(\d+)/g)) {
    min = Math.min(min, Number(x), Number(y));
    max = Math.max(max, Number(x) + Number(w), Number(y) + 1);
  }
  assert.ok(min >= QR_QUIET, `a module starts at ${min}`);
  assert.ok(max <= QR_SIZE - QR_QUIET, `a module ends at ${max}`);
});
