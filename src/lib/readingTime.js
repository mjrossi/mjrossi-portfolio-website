// Word-count read time.
//
// Plain JS rather than TypeScript so scripts/make-post-og.mjs can import it
// under plain Node: the OG card prints the same read time the page does, and
// two implementations of it would drift the first time WORDS_PER_MINUTE moved.
// Same anti-drift argument as scripts/content.mjs sharing coercePubDate.

const WORDS_PER_MINUTE = 200;

/**
 * @param {string} body
 * @returns {{ minutes: number, label: string }}
 */
export function readingTime(body) {
  const stripped = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\{[^}]*\}/g, ' ');
  const words = stripped.trim().split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.ceil(words / WORDS_PER_MINUTE));
  return { minutes, label: `${minutes} min read` };
}
