import { test } from 'node:test';
import assert from 'node:assert/strict';

import { escapeText, foldLine, serializeVCard, CARD_VCF } from './vcard.js';
import { TAGLINE, CARD_TAGLINE } from './identity.js';
import { CONTACT_EMAIL } from './contact.js';

const octets = (s) => Buffer.byteLength(s, 'utf8');
const physicalLines = (vcf) => vcf.split('\r\n').slice(0, -1);
const unfold = (vcf) => vcf.replace(/\r\n /g, '');

test('escapeText escapes backslash, comma, semicolon and every newline form', () => {
  assert.equal(escapeText('a\\b'), 'a\\\\b');
  assert.equal(escapeText('a,b'), 'a\\,b');
  assert.equal(escapeText('a;b'), 'a\\;b');
  assert.equal(escapeText('a\nb\r\nc\rd'), 'a\\nb\\nc\\nd');
  // Backslash first, or the escapes it adds would be escaped again.
  assert.equal(escapeText('\\,'), '\\\\\\,');
});

test('foldLine leaves a 75-octet line alone and folds a 76-octet one', () => {
  const at = 'x'.repeat(75);
  assert.equal(foldLine(at), at);
  const over = 'x'.repeat(76);
  assert.equal(foldLine(over), `${'x'.repeat(75)}\r\n x`);
});

test('foldLine keeps every physical line within 75 octets, continuation space included', () => {
  const folded = foldLine('NOTE:' + 'y'.repeat(400));
  for (const line of folded.split('\r\n')) assert.ok(octets(line) <= 75, `${octets(line)} octets`);
  assert.equal(folded.replace(/\r\n /g, ''), 'NOTE:' + 'y'.repeat(400));
});

test('foldLine never splits a multi-byte character', () => {
  // 'é' is two octets, '€' three, '𝄞' four; offsets chosen so a naive cut lands mid-sequence.
  for (const ch of ['é', '€', '𝄞']) {
    const value = 'NOTE:' + ch.repeat(90);
    const folded = foldLine(value);
    for (const line of folded.split('\r\n')) {
      assert.ok(octets(line) <= 75);
      // A split sequence decodes to U+FFFD.
      assert.ok(!Buffer.from(line, 'utf8').toString('utf8').includes('�'));
      assert.equal(Buffer.from(line, 'utf8').toString('utf8'), line);
    }
    assert.equal(folded.replace(/\r\n /g, ''), value);
  }
});

test('serializeVCard wraps in BEGIN/END, ends every line in CRLF, never a bare CR or LF', () => {
  const vcf = serializeVCard([['FN', escapeText('A, B')], ['NOTE', escapeText('one\ntwo')]]);
  assert.ok(vcf.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n'));
  assert.ok(vcf.endsWith('END:VCARD\r\n'));
  assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(vcf), 'bare CR or LF');
  assert.ok(vcf.includes('FN:A\\, B\r\n'));
  assert.ok(vcf.includes('NOTE:one\\ntwo\r\n'));
});

test('the card: CRLF throughout, folded within 75 octets', () => {
  assert.ok(!/\r(?!\n)|(?<!\r)\n/.test(CARD_VCF), 'bare CR or LF');
  for (const line of physicalLines(CARD_VCF)) assert.ok(octets(line) <= 75, `${octets(line)}: ${line}`);
});

test('the card: name, email and URL', () => {
  const vcf = unfold(CARD_VCF);
  assert.match(vcf, /\r\nN:Rossi;Matthew;;;\r\n/);
  assert.match(vcf, /\r\nFN:Matthew Rossi\r\n/);
  assert.ok(vcf.includes(`\r\nEMAIL;TYPE=INTERNET:${CONTACT_EMAIL}\r\n`));
  assert.match(vcf, /\r\nURL:https:\/\/mjrossi\.com\r\n/);
});

// A saved contact is held indefinitely, like a cached social card, so it may
// state identity only. TAGLINE ("studying …") is a fact about the present.
test('the card says CARD_TAGLINE, never TAGLINE', () => {
  const vcf = unfold(CARD_VCF);
  assert.ok(vcf.includes(`\r\nNOTE:${escapeText(CARD_TAGLINE)}\r\n`));
  assert.ok(!vcf.includes(escapeText(TAGLINE)));
  assert.ok(!vcf.includes(TAGLINE));
});

test('the card carries a base64 JPEG photo', () => {
  const photo = unfold(CARD_VCF).match(/\r\nPHOTO;ENCODING=b;TYPE=JPEG:([^\r]+)\r\n/)?.[1];
  assert.ok(photo, 'no PHOTO line');
  assert.match(photo, /^\/9j\//, 'not a JPEG (FF D8 FF)');
  assert.match(photo, /^[A-Za-z0-9+/]+=*$/);
  const bytes = Buffer.from(photo, 'base64');
  assert.equal(bytes[0], 0xff);
  assert.equal(bytes[1], 0xd8);
});
