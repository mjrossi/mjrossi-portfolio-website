// The `.vcf` behind /card's "Add to contacts", and the serialiser that writes it.
//
// A FOURTH rendering engine for src/lib/identity.js, after Base.astro (HTML),
// make-og.mjs (SVG) and the Buttondown template (markdown) — and like the
// others it gets plain text and does its own escaping. vCard's rules are its
// own: `\` `,` `;` and newlines escaped in text values, every line ending in
// CRLF, and lines folded at 75 OCTETS (not characters) with a single leading
// space on each continuation (RFC 2425 §5.8.1, which vCard 3.0 inherits).
//
// The TITLE is CARD_TAGLINE, never TAGLINE. A saved contact is held by someone
// else indefinitely — exactly like a scraper's copy of the social card — so it
// may state identity only. "Studying …" is a fact about the present.
//
// TITLE rather than NOTE: iOS Contacts shows TITLE directly under the name,
// where it does the job of recalling who this was a week later, and NOTE at the
// foot of the card, where nobody looks. One line, not both — the same words
// twice on one contact is noise.
//
// Plain JS so `node --test` reaches it (src/lib/vcard.test.js); the endpoint
// is src/pages/api/vcard.ts and serves CARD_VCF unchanged.
import { CARD_TAGLINE } from './identity.js';
import { CONTACT_EMAIL } from './contact.js';
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
 * Fold one content line into physical lines of at most 75 octets, joined by
 * CRLF + space. Walks code points rather than UTF-16 units or bytes, so a
 * multi-byte character is never cut in half — a split sequence is what turns a
 * name into U+FFFD on the recipient's phone.
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
 * `props` is `[name, value]` pairs, values already escaped or encoded as their
 * type requires — the caller knows a URI from TEXT, this does not. Returns the
 * whole card, CRLF throughout and after the last line.
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

// The structured name is spelled here rather than lifted into identity.js, for
// that file's own reason: like the two-tone wordmark, `N` is a shape
// (family;given;additional;prefix;suffix), not a sentence another engine says.
//
// The URLs are Apple's grouped form — `itemN.URL` with an `itemN.X-ABLabel` —
// because vCard 3.0's URL takes no TYPE, and without a label every app shows
// four bare "URL"s. `_$!<HomePage>!$_` is the label iOS itself writes for
// "homepage"; the profiles are labelled by name. The `itemN.` group prefix is
// plain RFC 2426 syntax, so an app that ignores X-ABLabel still reads the URL.
// Not X-SOCIALPROFILE: it is Apple-only, and iOS lists a profile given both
// ways twice.
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
  ...urls,
  ['PHOTO;ENCODING=b;TYPE=JPEG', PHOTO_JPEG_BASE64],
]);
