// Tag display and the retired-slug map.
//
// Two jobs, one module, because they are the same fact seen from two sides:
// what a topic is called, and what it used to be called.
//
// Finding 4.4: chips displayed the raw slug (`safe-streets`, `urban-mobility`).
// The slug is a URL, not a label — it stays in the URL and a title-cased label
// goes on screen. Derived rather than enumerated, so a new tag is one word in
// frontmatter and nothing else; LABELS is for the words title-casing gets
// wrong, and is empty today on purpose.
//
// Finding 2.1: the vocabulary was consolidated from thirteen tags to nine, and
// a retired tag's URL may already have been shared. RETIRED redirects those
// rather than 404ing them — which is also why this is plain JS with a test: a
// map that silently pointed at a slug no longer in the working set would send
// a reader from one 404 to another.

/** Slugs whose title-cased form is wrong. Add sparingly. */
const LABELS = {};

/** Words that stay lowercase inside a label (never in first position). */
const MINOR = new Set(['and', 'or', 'the', 'a', 'an', 'of', 'in', 'to', 'for']);

/**
 * `'safe-streets'` → `'Safe Streets'`.
 *
 * @param {string} slug
 * @returns {string}
 */
export function tagLabel(slug) {
  if (Object.hasOwn(LABELS, slug)) return LABELS[slug];
  return slug
    .split('-')
    .map((word, i) =>
      i > 0 && MINOR.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1),
    )
    .join(' ');
}

/**
 * Retired slug → where it goes now.
 *
 * `urban-mobility` has no successor: it was on every post, which is what made
 * it worth retiring, so it lands on the index rather than on a topic that
 * would misrepresent it.
 */
export const RETIRED = {
  'urban-mobility': '/blog',
  walkability: '/blog/tag/advocacy',
  'safe-streets': '/blog/tag/advocacy',
  netherlands: '/blog/tag/cycling',
  accessibility: '/blog/tag/infrastructure',
  'data-modeling': '/blog/tag/software-engineering',
  'open-source': '/blog/tag/software-engineering',
};

/**
 * Where a retired tag redirects to, or null if the slug was never retired.
 *
 * @param {string} slug
 * @returns {string|null}
 */
export function retiredTarget(slug) {
  return Object.hasOwn(RETIRED, slug) ? RETIRED[slug] : null;
}
