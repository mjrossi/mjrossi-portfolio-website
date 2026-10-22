import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { escapeText, foldLine, serializeVCard, CARD_VCF } from './vcard.js';
import { CONTACT_PROFILES } from './profiles.js';
import { TAGLINE, CARD_TAGLINE } from './identity.js';
import { CONTACT_EMAIL, CONTACT_PHONE } from './contact.js';

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

test('the card: name, nickname, email and phone', () => {
  const vcf = unfold(CARD_VCF);
  assert.match(vcf, /\r\nN:Rossi;Matthew;;;\r\n/);
  assert.match(vcf, /\r\nFN:Matthew Rossi\r\n/);
  assert.match(vcf, /\r\nNICKNAME:Matt\r\n/);
  assert.ok(vcf.includes(`\r\nEMAIL;TYPE=INTERNET:${CONTACT_EMAIL}\r\n`));
  assert.ok(vcf.includes(`\r\nTEL;TYPE=CELL:${CONTACT_PHONE}\r\n`));
  assert.match(CONTACT_PHONE, /^\+\d[\d ]+$/, 'international form, digits and spaces only');
});

// Each URL is paired with its label by group, so a URL whose label went
// missing, or two that swapped labels, would show the wrong name beside it.
test('the card: the site as homepage, then each profile, each with its own label', () => {
  const vcf = unfold(CARD_VCF);
  const expected = [
    ['https://mjrossi.com', '_$!<HomePage>!$_'],
    ...CONTACT_PROFILES.map(({ url, label }) => [url, label]),
  ];
  const urls = [...vcf.matchAll(/\r\n(item\d+)\.URL:([^\r]+)/g)];
  assert.equal(urls.length, expected.length);
  urls.forEach(([, group, url], i) => {
    assert.equal(url, expected[i][0]);
    assert.ok(vcf.includes(`\r\n${group}.X-ABLabel:${expected[i][1]}\r\n`), `${group} label`);
  });
  assert.ok(!/\r\nURL[:;]/.test(vcf), 'no ungrouped URL');
  assert.deepEqual(CONTACT_PROFILES.map((p) => p.label), ['LinkedIn', 'Bluesky', 'GitHub']);
});

// A saved contact is held indefinitely, like a cached social card, so it may
// state identity only. TAGLINE ("studying …") is a fact about the present.
// TITLE is what sits under the name in iOS Contacts; it carries the
// descriptor, and NOTE is gone so the same words do not appear twice.
test('the card says CARD_TAGLINE as its TITLE, never TAGLINE, and has no NOTE', () => {
  const vcf = unfold(CARD_VCF);
  assert.ok(vcf.includes(`\r\nFN:Matthew Rossi\r\nTITLE:${escapeText(CARD_TAGLINE)}\r\n`));
  assert.ok(!vcf.includes(escapeText(TAGLINE)));
  assert.ok(!vcf.includes(TAGLINE));
  assert.ok(!/\r\nNOTE[:;]/.test(vcf));
});

test('a TITLE is escaped and folded like any other TEXT property', () => {
  const title = 'Technologist, urbanist; ' + 'x'.repeat(100);
  const vcf = serializeVCard([['TITLE', escapeText(title)]]);
  for (const line of physicalLines(vcf)) assert.ok(octets(line) <= 75, `${octets(line)}: ${line}`);
  assert.ok(unfold(vcf).includes(`\r\nTITLE:Technologist\\, urbanist\\; ${'x'.repeat(100)}\r\n`));
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

// The markers ahead of the first scan: the header, where metadata lives.
function headerMarkers(bytes) {
  const markers = [];
  let i = 2;
  while (i + 4 <= bytes.length) {
    assert.equal(bytes[i], 0xff, `no marker at offset ${i}`);
    const marker = bytes[i + 1];
    markers.push(marker);
    if (marker === 0xda) break; // SOS: entropy-coded data follows
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return markers;
}

// The photo is a saved contact: held by someone else, indefinitely. The
// camera original carried GPS EXIF, and the source file is committed, so a
// hand-replaced contact-photo.jpg straight off a phone would put a location in
// git even though sharp strips the output. Baseline because older importers
// mishandle progressive — and sharp makes mozjpeg output progressive whatever
// `progressive` says, so re-adding mozjpeg would flip this silently.
test('the photo is baseline and carries no Exif, XMP or IPTC, in the vCard and at the source', () => {
  const photo = unfold(CARD_VCF).match(/\r\nPHOTO;ENCODING=b;TYPE=JPEG:([^\r]+)\r\n/)[1];
  const sources = {
    vcard: Buffer.from(photo, 'base64'),
    'contact-photo.jpg': readFileSync(new URL('../assets/contact-photo.jpg', import.meta.url)),
  };
  for (const [name, bytes] of Object.entries(sources)) {
    const markers = headerMarkers(bytes);
    assert.ok(!markers.includes(0xe1), `${name}: APP1 (Exif/XMP) present`);
    assert.ok(!markers.includes(0xed), `${name}: APP13 (IPTC) present`);
  }
  const markers = headerMarkers(sources.vcard);
  assert.ok(markers.includes(0xc0), 'vCard photo is not baseline (no SOF0)');
  assert.ok(!markers.includes(0xc2), 'vCard photo is progressive (SOF2)');
});
