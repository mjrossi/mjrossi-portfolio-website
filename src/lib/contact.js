// The address, spelled once, for its two carriers: /api/contact's 302 Location
// and /api/vcard's .vcf. Keeping it out of rendered HTML is why both are
// endpoints, so no .astro file may import this. Smoke asserts that, and that
// nothing else spells the address.

export const CONTACT_EMAIL = 'hello@mjrossi.com';
