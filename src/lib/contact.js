// The address, spelled once, for its two carriers: /api/contact's 302 Location
// and /api/vcard's .vcf. Keeping it out of rendered HTML is why both are
// endpoints, so no .astro file may import this. Smoke asserts that, and that
// nothing else spells the address.
//
// The phone number lives here under the same rule, with one carrier: the .vcf.
// It is for people handed the card, not for a scraper reading the page.

export const CONTACT_EMAIL = 'hello@mjrossi.com';
export const CONTACT_PHONE = '+351 965 260 960';
