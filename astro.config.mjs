import { defineConfig, fontProviders } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';

import cloudflare from "@astrojs/cloudflare";
import remarkSourceAnchors from './src/lib/remark-source-anchors.js';
import { isAdminPath } from './src/lib/admin-path.js';

export default defineConfig({
  site: 'https://mjrossi.com',
  output: 'server',
  integrations: [
    mdx(),
    // /admin is the Desk: an Access-gated operator surface listing every
    // scheduled draft, every outstanding preview link and every galley note.
    // Middleware 404s it without a valid Access JWT, but a sitemap entry would
    // still publish the fact that those paths exist and hand a crawler the slug
    // of every unpublished post — which is the one thing scheduled publishing
    // is for.
    //
    // The predicate is shared with middleware (src/lib/admin-path.js) rather
    // than spelled again here, because a filter that disagreed with the gate is
    // exactly the drift that puts a draft inventory in a public file.
    sitemap({ filter: (page) => !isAdminPath(new URL(page).pathname) }),
  ],
  // Applies to .md and .mdx alike: @astrojs/mdx extends the markdown config by
  // default (extendMarkdownConfig), so the anchors the galley depends on are
  // stamped on every post without configuring the integration separately.
  markdown: {
    remarkPlugins: [remarkSourceAnchors],
  },
  adapter: cloudflare({ imageService: 'compile' }),
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'Inter',
      cssVariable: '--font-inter',
      weights: [400, 500, 600],
      styles: ['normal'],
      subsets: ['latin'],
      display: 'swap',
    },
    {
      provider: fontProviders.google(),
      name: 'Fraunces',
      cssVariable: '--font-fraunces',
      weights: [400, 600],
      styles: ['normal', 'italic'],
      subsets: ['latin'],
      display: 'swap',
    },
    {
      provider: fontProviders.google(),
      name: 'Source Serif 4',
      cssVariable: '--font-source-serif',
      weights: [400, 600],
      styles: ['normal', 'italic'],
      subsets: ['latin'],
      display: 'swap',
    },
  ],
  vite: {
    // The instant this bundle was built, inlined as a literal.
    //
    // src/layouts/BlogPost.astro needs it to answer a question `new Date()`
    // cannot: not "is this post published?" (which changes between deploys —
    // that is the whole scheduled-publishing feature) but "was it published
    // when scripts/make-post-og.mjs ran?", which is exactly the set of posts
    // that have a card at /og/<slug>.png. A post that publishes by its pubDate
    // passing, with no redeploy behind it, would otherwise start advertising a
    // card nobody generated — a 404'd social image during the manual
    // syndication window, which is the one hour it matters.
    //
    // The two clocks cannot disagree in the dangerous direction: `npm run
    // build` runs make-post-og AFTER astro build, so its `now` is strictly
    // later, so {advertised} ⊆ {written}. The worst case is a post that went
    // live mid-build getting a card it doesn't link yet.
    define: {
      __BUILD_TIME__: JSON.stringify(Date.now()),
    },
    build: {
      rollupOptions: {
        output: {
          // Astro names page-scoped CSS chunks with `@_@` (e.g.
          // `index@_@astro.<hash>.css`). Cloudflare's Static Assets binding
          // URL-decodes the path, so the literal `@` form 307s to the
          // percent-encoded form on every load — ~337ms on the LCP critical
          // path. Sanitize names with `@` to a `-` so the first hit is served
          // directly. Non-`@` assets keep Astro's default naming so the smoke
          // tests still find `Base.<hash>.css`.
          assetFileNames: (info) => {
            const original = info.name || 'asset';
            if (!original.includes('@')) {
              return '_astro/[name].[hash][extname]';
            }
            const dot = original.lastIndexOf('.');
            const ext = dot >= 0 ? original.slice(dot) : '';
            const base = (dot >= 0 ? original.slice(0, dot) : original)
              .replace(/@_@/g, '-')
              .replace(/@/g, '-');
            return `_astro/${base}-[hash]${ext}`;
          },
        },
      },
    },
  },
});
