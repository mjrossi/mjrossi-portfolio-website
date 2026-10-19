// The sentences the site says about itself, in one place.
//
// These are said in two rendering engines that CAN import them (a third that
// cannot is covered below): `src/layouts/Base.astro` renders
// them as HTML on every page, and `scripts/make-og.mjs` renders them into an
// SVG that sharp rasterises to `public/og.png`. A string spelled once per
// engine is a string that drifts — and the OG card is the half that drifts
// silently, because it is a manual `just og` step rather than a build step and
// nobody looks at a PNG. That is exactly how the card came to claim "Brooklyn,
// New York" for months after the masthead said Lisbon.
//
// Plain JS, not TypeScript, for the same reason `edition.js`, `schedule.js` and
// `readingTime.js` are: `make-og.mjs` imports this under bare Node.
//
// STORE PLAIN TEXT. Escaping belongs to whoever renders it — Astro escapes a
// `{}` expression itself, while the SVG generator has to emit `&amp;`. A string
// pre-escaped for one of them is wrong in the other, and `&amp;` rendered as
// HTML shows up on the page as literal `&amp;`.
//
// There is a THIRD engine for the colophon, and it cannot import this file:
// `docs/buttondown-rss-template.md` is pasted by hand into Buttondown's
// dashboard, so it spells `SET_IN` and `BUILT_WITH` as literal markdown. That
// copy is pinned the other way round — `scripts/smoke/static.mjs` asserts the
// template still matches these constants, so changing one of them fails the
// build until the template is updated and re-pasted. Editing a sentence here is
// therefore an operator step as well as a code change.
//
// A FOURTH engine can import it: `src/lib/vcard.js`, the `.vcf` behind /card's
// "Add to contacts", which has escaping and line-folding rules of its own. It
// says CARD_TAGLINE, never TAGLINE, for the card's reason — a saved contact is
// held by someone else indefinitely — and `src/lib/vcard.test.js` asserts it.
//
// `scripts/make-linkedin-banner.mjs` renders CARD_TAGLINE into the LinkedIn
// banner, for the same reason, and refuses to run if the line it draws is not
// CARD_TAGLINE.
//
// What is deliberately NOT here: the two-tone "Matthew Rossi" wordmark and the
// `mjrossi.com` domain. Both are also spelled in more than one engine (adding
// `scripts/make-post-og.mjs` as a third), but the wordmark is markup rather
// than a sentence — an `<h1>` with a `<span>` here, a `<text>` with a `<tspan>`
// there — so there is no shared value to lift, only a shared shape.

/**
 * The masthead tagline. Also the spine of `SITE_DESCRIPTION` below.
 *
 * NOT the social card's line. "Studying" is a fact about the present, and
 * the card may state identity only (see `scripts/make-og.mjs`): the page is
 * re-rendered on every request and can follow this sentence, but the card is
 * cached by scrapers that never re-fetch it. The card says `CARD_TAGLINE`.
 */
export const TAGLINE = 'Technologist studying how cities move people';

/**
 * The social card's line: who, not what now. It must stay true for as long as
 * a scraper might hold the card, which is indefinitely. Changing it means
 * `just og`, then bumping `?v=` on `Base.astro`'s `ogImage` default.
 */
export const CARD_TAGLINE = 'Technologist and urbanist';

/**
 * The Urbanist Lexicon's own line: the tagline of the periodical's masthead on
 * every blog route, and the description of `/blog`. Kept apart from `TAGLINE`
 * because the two mastheads say different things about different subjects —
 * the site is about its author, the Lexicon is about its subject.
 */
export const LEXICON_TAGLINE = 'A record of systems, movement, and the transition from bits to bricks';

/** Colophon, first half — the one both the page footer and the card carry. */
export const SET_IN = 'Set in Fraunces & Source Serif';

/** Colophon, second half — the page footer only; the card has no room. */
export const BUILT_WITH = 'Built in Astro, served from the edge';

/**
 * The default `<meta name="description">` only — the tagline as a sentence,
 * with the byline in front. Search engines re-read it on every crawl, so it
 * may follow `TAGLINE`; `og:description` may not, and says `CARD_DESCRIPTION`.
 *
 * Derived rather than spelled out because it *is* the tagline: written
 * separately it was a fourth copy, and the one furthest from anything a reader
 * or an author ever looks at. Rewrite `TAGLINE` and this follows.
 */
export const SITE_DESCRIPTION =
  `Matthew Rossi — ${TAGLINE[0].toLowerCase()}${TAGLINE.slice(1)}.`;

/**
 * The default `og:description` / `twitter:description` and `og:image:alt` /
 * `twitter:image:alt`. A link preview is kept indefinitely by whoever scraped
 * it, and alt text describes the image, so both follow the card's line, not
 * the masthead's.
 */
export const CARD_DESCRIPTION =
  `Matthew Rossi — ${CARD_TAGLINE[0].toLowerCase()}${CARD_TAGLINE.slice(1)}.`;
