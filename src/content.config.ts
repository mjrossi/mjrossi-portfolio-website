import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { coercePubDate } from './lib/pubdate.js';

/**
 * A frontmatter date, resolved to an instant.
 *
 * Replaces `z.coerce.date()`, which accepted the one shape that means two
 * different things: a QUOTED timestamp with no time zone
 * (`"2026-05-10T14:00:00"`) is read by `new Date()` as LOCAL time, while the
 * same literal unquoted is read by YAML as UTC. Nothing about the file says
 * which you got. coercePubDate refuses it and says how to fix it; see
 * src/lib/pubdate.js for the full table, and src/lib/pubdate.test.js for the
 * js-yaml behaviour it all rests on.
 *
 * Fails the build, which is the right place for it — the alternative is a post
 * going live up to a day off with nothing red anywhere.
 */
const frontmatterDate = (field: string) =>
  z.union([z.date(), z.string()]).transform((value, ctx) => {
    const result = coercePubDate(value, field);
    if (!result.ok) {
      ctx.addIssue({ code: 'custom', message: result.message });
      return z.NEVER;
    }
    return result.date;
  });

const blog = defineCollection({
  loader: glob({
    pattern: '**/*.{md,mdx}',
    base: './src/content/blog',
    // Colocated posts live at <slug>/index.mdx so images can sit next to the
    // post. Strip `/index` so the id (and therefore the URL) is just <slug>.
    // A bare `index.mdx` at the root would collapse to an empty id and
    // collide with the listing page — fail loudly instead.
    generateId: ({ entry }) => {
      const id = entry.replace(/(?:\/index)?\.mdx?$/, '');
      if (id === '' || id === 'index') {
        throw new Error(
          `src/content/blog/${entry}: a post file named "index" at the root is not allowed — it would collide with /blog/. Rename the file or move it into a <slug>/ directory.`,
        );
      }
      return id;
    },
  }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      // A bare YYYY-MM-DD is midnight UTC; add a time when the hour matters —
      // see "Scheduled publishing" in CLAUDE.md.
      pubDate: frontmatterDate('pubDate'),
      updatedDate: frontmatterDate('updatedDate').optional(),
      // Tags are interpolated unescaped into URL paths and HTML attributes
      // (see src/pages/blog/tag/[tag].astro and the post-list pages). This
      // regex is the security invariant that makes that safe — relaxing it
      // requires auditing every interpolation site for escaping.
      tags: z
        .array(
          z
            .string()
            .regex(
              /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
              'tags must be lowercase kebab-case (letters, digits, and internal hyphens only)',
            ),
        )
        .default([]),
      cover: z
        .object({
          src: image(),
          alt: z.string(),
          caption: z.string().optional(),
        })
        .optional(),
    }),
});

export const collections = { blog };
