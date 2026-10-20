// Tag display, and where retired tags go now.
//
// A slug is a URL, not a label: chips show a title-cased label derived from it,
// so a new tag needs nothing but frontmatter. RETIRED 301s the tags the
// consolidation removed, since their URLs may have been shared. tags.test.js
// fails if a target is not a live slug.

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
 * Retired slug → where it goes now. `urban-mobility` was on every post, so it
 * goes to the index rather than to a topic that would misrepresent it.
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
