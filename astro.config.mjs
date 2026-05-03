import { defineConfig, fontProviders } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';

import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  site: 'https://mjrossi.com',
  output: 'static',
  integrations: [
    mdx(),
    sitemap(),
  ],
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
