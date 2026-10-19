import test from 'node:test';
import assert from 'node:assert/strict';

import { paperTokens, rootTokens, toHex } from '../../scripts/paper-tokens.mjs';

// The failure here is a plausible wrong colour — an image a shade off the site,
// which nobody compares by eye. So the conversion is pinned against fixed
// points, and the reader against the stylesheet that actually ships.

test('toHex: oklch fixed points', () => {
  assert.equal(toHex('oklch(100% 0 0)'), '#ffffff');
  assert.equal(toHex('oklch(0% 0 0)'), '#000000');
  // sRGB red, from the CSS Color 4 spec's own oklch() example.
  assert.equal(toHex('oklch(62.8% 0.2577 29.23)'), '#ff0000');
});

test('toHex: hex passes through, anything else throws', () => {
  assert.equal(toHex('#8F5520'), '#8f5520');
  assert.throws(() => toHex('var(--text)'));
  assert.throws(() => toHex('rgb(0 0 0)'));
});

test('rootTokens: reads the bare :root block only, never Night', () => {
  const css = `
:root {
  /* a comment: --fake: #000000; */
  --bg: #ffffff;
}
@media screen {
  :root[data-theme="dark"] { --bg: #000000; }
}`;
  assert.deepEqual(rootTokens(css), { '--bg': '#ffffff' });
});

test('paperTokens: every colour the banner draws with resolves from global.css', () => {
  const paper = paperTokens();
  for (const name of [
    '--bg', '--text', '--accent-band', '--accent-band-border',
    '--accent-rule', '--accent-tagline', '--accent-surname',
  ]) {
    assert.match(paper.colour(name), /^#[0-9a-f]{6}$/, name);
  }
  // The one token smoke pins at :root, so the reader is reading Paper.
  assert.equal(paper.colour('--accent'), '#8f5520');
  assert.equal(paper.number('--grain-opacity'), 0.35);
  assert.throws(() => paper.colour('--no-such-token'));
});
