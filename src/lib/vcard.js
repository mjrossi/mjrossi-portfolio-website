// The `.vcf` behind /card's "Add to contacts", and its serialiser.
//
// vCard's own rules: `\` `,` `;` and newlines escaped in TEXT values, CRLF
// throughout, lines folded at 75 OCTETS with a leading space on each
// continuation (RFC 2425 §5.8.1).
//
// TITLE is CARD_TAGLINE, never TAGLINE: a saved contact is kept indefinitely,
// so it states identity only. TITLE, not NOTE, because iOS shows it under the
// name.
import { CARD_TAGLINE } from './identity.js';
import { CONTACT_EMAIL, CONTACT_PHONE } from './contact.js';
import { PHOTO_JPEG_BASE64 } from './card-photo.js';
import { CONTACT_PROFILES } from './profiles.js';

const MAX_OCTETS = 75;
const encoder = new TextEncoder();

/** Escape a TEXT value. Backslash first, or its own escapes get escaped again. */
export function escapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * Fold one line to at most 75 octets per physical line. Walks code points, so a
 * multi-byte character is never split into U+FFFD on the recipient's phone.
 */
export function foldLine(line) {
  const out = [];
  let current = '';
  let used = 0;
  // The continuation's leading space is part of its 75.
  let budget = MAX_OCTETS;
  for (const ch of line) {
    const size = encoder.encode(ch).length;
    if (used + size > budget) {
      out.push(current);
      current = '';
      used = 0;
      budget = MAX_OCTETS - 1;
    }
    current += ch;
    used += size;
  }
  out.push(current);
  return out.join('\r\n ');
}

/**
 * `props` are `[name, value]` pairs, already escaped as their type requires.
 * Returns the whole card, CRLF after every line.
 */
export function serializeVCard(props) {
  const lines = [
    'BEGIN:VCARD',
    'VERSION:3.0',
    ...props.map(([name, value]) => `${name}:${value}`),
    'END:VCARD',
  ];
  return lines.map(foldLine).join('\r\n') + '\r\n';
}

// URLs in Apple's grouped form (`itemN.URL` + `itemN.X-ABLabel`), since vCard
// 3.0's URL takes no TYPE and unlabelled they all read "URL". `_$!<HomePage>!$_`
// is iOS's own homepage label. Not X-SOCIALPROFILE: iOS would list each twice.
const urls = [
  { label: '_$!<HomePage>!$_', url: 'https://mjrossi.com' },
  ...CONTACT_PROFILES,
].flatMap(({ label, url }, i) => [
  // A URI, not TEXT — escaping would corrupt a comma or semicolon in a path.
  [`item${i + 1}.URL`, url],
  [`item${i + 1}.X-ABLabel`, escapeText(label)],
]);

export const CARD_VCF = serializeVCard([
  ['N', ['Rossi', 'Matthew', '', '', ''].map(escapeText).join(';')],
  ['FN', escapeText('Matthew Rossi')],
  ['TITLE', escapeText(CARD_TAGLINE)],
  // So a search of the recipient's contacts for "Matt" finds this one.
  ['NICKNAME', escapeText('Matt')],
  ['EMAIL;TYPE=INTERNET', escapeText(CONTACT_EMAIL)],
  // A phone-number value, not TEXT. International form, so it dials from abroad.
  ['TEL;TYPE=CELL', CONTACT_PHONE],
  ...urls,
  ['PHOTO;ENCODING=b;TYPE=JPEG', PHOTO_JPEG_BASE64],
]);
