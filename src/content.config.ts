import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';
import { coercePubDate } from './lib/pubdate.js';

/**
 * A frontmatter date, through coercePubDate rather than `z.coerce.date()`,
 * which accepted the one ambiguous shape (a quoted timestamp with no zone).
 * Fails the build; see src/lib/pubdate.js.
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
    // `<slug>/index.mdx` is just <slug>. A root `index.mdx` would collide with
    // /blog/, so it fails loudly.
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
      pubDate: frontmatterDate('pubDate'),
      updatedDate: frontmatterDate('updatedDate').optional(),
      // SECURITY INVARIANT: tags are interpolated unescaped into URL paths and
      // attributes. Relaxing this means auditing every interpolation site.
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
