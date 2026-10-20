// Paper's colour tokens, read from the bare `:root` in src/styles/global.css
// for image generators under bare Node, so a palette change needs no re-sync.
// Paper only: one image serves every theme. librsvg can't read oklch(), so
// values become sRGB hex (Ottosson's OKLab matrices, clipped per channel).
// Only `#rrggbb` and `oklch(L% C h)` are handled; anything else throws.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const STYLESHEET = 'src/styles/global.css';

/**
 * Every custom property declared in the bare `:root` block, as raw text.
 *
 * @param {string} css
 * @returns {Record<string, string>}
 */
export function rootTokens(css) {
  const block = css.match(/^:root\s*\{([\s\S]*?)^\}/m)?.[1];
  if (block === undefined) throw new Error('paper-tokens: no bare :root block in the stylesheet');
  const tokens = {};
  const body = block.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

const toByte = (x) => {
  const v = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
};

/**
 * A CSS colour, as `#rrggbb`.
 *
 * @param {string} value
 * @returns {string}
 */
export function toHex(value) {
  const hex = value.match(/^#([0-9a-f]{6})$/i);
  if (hex) return `#${hex[1].toLowerCase()}`;

  const m = value.match(/^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/);
  if (!m) throw new Error(`paper-tokens: not a colour this reader handles: ${value}`);
  const L = Number(m[1]) / 100;
  const C = Number(m[2]);
  const h = (Number(m[3]) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);

  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;

  const rgb = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.7076147010 * s,
  ];
  return `#${rgb.map((c) => toByte(c).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Paper's tokens, with a lookup that refuses a name the stylesheet lacks — a
 * renamed token must fail the generator, not render a default.
 *
 * @param {string} [path]
 */
export function paperTokens(path = STYLESHEET) {
  const tokens = rootTokens(readFileSync(resolve(path), 'utf8'));
  return {
    tokens,
    /** @param {string} name */
    colour(name) {
      if (!(name in tokens)) throw new Error(`paper-tokens: ${name} is not declared at :root`);
      return toHex(tokens[name]);
    },
    /** @param {string} name */
    number(name) {
      const n = Number(tokens[name]);
      if (!(name in tokens) || !Number.isFinite(n)) throw new Error(`paper-tokens: ${name} is not a number at :root`);
      return n;
    },
  };
}
