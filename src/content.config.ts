import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

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
