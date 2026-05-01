// One-off regenerator for public/noise.webp (the masthead grain overlay).
// Run from the project root after editing the SVG below:
//   node scripts/make-noise.mjs public/noise.webp
import sharp from 'sharp';
import { writeFileSync } from 'node:fs';

const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220">
  <filter id="n">
    <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/>
    <feColorMatrix type="saturate" values="0"/>
    <feComponentTransfer><feFuncA type="linear" slope="0.22"/></feComponentTransfer>
  </filter>
  <rect width="100%" height="100%" filter="url(#n)"/>
</svg>`;

const out = await sharp(Buffer.from(svg))
  .resize(220, 220)
  .webp({ quality: 80, alphaQuality: 90 })
  .toBuffer();

writeFileSync(process.argv[2], out);
console.log(`wrote ${out.length} bytes to ${process.argv[2]}`);
