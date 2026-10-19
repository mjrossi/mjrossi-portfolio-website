// The address mail reaches me at, spelled once.
//
// It is said in two places and neither of them is HTML: `/api/contact` puts it
// in a 302's `Location`, so a `mailto:` link never carries it in markup, and
// `/api/vcard` puts it in the `.vcf` a recipient saves. Keeping the address out
// of rendered pages is the reason both are endpoints — see
// `src/pages/api/contact.ts` — so nothing under `src/pages/*.astro` or
// `src/components/` may import this. Smoke asserts `/card`, the one page that
// links both, never contains it.

export const CONTACT_EMAIL = 'hello@mjrossi.com';
