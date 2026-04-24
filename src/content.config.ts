import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const blog = defineCollection({
  loader: glob({
    pattern: '**/*.{md,mdx}',
    base: './src/content/blog',
    // Colocated posts live at <slug>/index.mdx so images can sit next to the
    // post. Strip `/index` so the id (and therefore the URL) is just <slug>.
    generateId: ({ entry }) => entry.replace(/(?:\/index)?\.mdx?$/, ''),
  }),
  schema: ({ image }) =>
    z.object({
      title: z.string(),
      description: z.string(),
      pubDate: z.coerce.date(),
      updatedDate: z.coerce.date().optional(),
      // Tags are used verbatim as URL path segments (`/blog/tag/<tag>`), so
      // restrict them to lowercase kebab-case. Authors get a build error
      // instead of a broken route.
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
        })
        .optional(),
      draft: z.boolean().default(false),
    }),
});

export const collections = { blog };
