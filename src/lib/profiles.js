// The off-site profiles, spelled once for the two places that carry them: the
// icon row (src/components/ContactLinks.astro, twice per page) and the saved
// contact (src/lib/vcard.js). A handle that moved in one and not the other
// would leave everyone who saved the .vcf pointing at the old one, and nothing
// could reach their copy to correct it.
//
// `label` is what a contact app shows beside the URL, and the icon's
// aria-label. Plain JS so `node --test` reaches it through vcard.js.
export const GITHUB = { label: 'GitHub', url: 'https://github.com/mjrossi' };
export const LINKEDIN = { label: 'LinkedIn', url: 'https://www.linkedin.com/in/matthew-j-rossi/' };
export const BLUESKY = { label: 'Bluesky', url: 'https://bsky.app/profile/mjrossi.com' };

// The saved contact's order: who you are professionally, where you post,
// then the code.
export const CONTACT_PROFILES = [LINKEDIN, BLUESKY, GITHUB];
