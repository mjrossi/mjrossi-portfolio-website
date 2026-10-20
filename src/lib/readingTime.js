// Word-count read time. Plain JS so the OG card (scripts/make-post-og.mjs)
// prints the same number the page does.

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
