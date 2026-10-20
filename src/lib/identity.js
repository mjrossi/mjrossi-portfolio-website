// The sentences the site says about itself, in one place, for every engine that
// renders them: Base.astro (HTML), scripts/make-og.mjs (the OG PNG),
// src/lib/vcard.js (the .vcf) and scripts/make-linkedin-banner.mjs. Spelled
// once per engine, the PNG drifted silently for months.
//
// STORE PLAIN TEXT; escaping belongs to each renderer.
//
// docs/buttondown-rss-template.md cannot import this and spells SET_IN and
// BUILT_WITH by hand; smoke asserts it still matches, so editing those is also
// an operator step (re-paste the template).
//
// The wordmark and the domain are not here: they are shared markup, not a
// shared string.

/**
 * The masthead tagline, and the spine of SITE_DESCRIPTION. Not the social
 * card's: "studying" is about the present, and scrapers never re-fetch a card.
 */
export const TAGLINE = 'Technologist studying how cities move people';

/**
 * The social card's line: who, not what now, true for as long as a scraper
 * holds the card. Changing it means `just og` and bumping `?v=` on the default
 * `ogImage` in Base.astro.
 */
export const CARD_TAGLINE = 'Technologist and urbanist';

/** The Lexicon's masthead line on every blog route, and /blog's description. */
export const LEXICON_TAGLINE = 'A record of systems, movement, and the transition from bits to bricks';

/** Colophon, first half: page footer and card. */
export const SET_IN = 'Set in Fraunces & Source Serif';

/** Colophon, second half: page footer only. */
export const BUILT_WITH = 'Built in Astro, served from the edge';

/**
 * The default `<meta name="description">`. Search engines re-crawl it, so it
 * follows TAGLINE; og:description does not.
 */
export const SITE_DESCRIPTION =
  `Matthew Rossi — ${TAGLINE[0].toLowerCase()}${TAGLINE.slice(1)}.`;

/**
 * The default og:/twitter: description and image alt. Link previews are kept
 * indefinitely, so this follows the card's line.
 */
export const CARD_DESCRIPTION =
  `Matthew Rossi — ${CARD_TAGLINE[0].toLowerCase()}${CARD_TAGLINE.slice(1)}.`;
