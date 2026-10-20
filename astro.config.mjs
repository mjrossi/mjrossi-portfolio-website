import { defineConfig, fontProviders } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import mdx from '@astrojs/mdx';
import { unified } from '@astrojs/markdown-remark';

import cloudflare from "@astrojs/cloudflare";
import remarkSourceAnchors from './src/lib/remark-source-anchors.js';
import { isAdminPath } from './src/lib/admin-path.js';

// The business card and its presenter's view: utility pages, not content.
const CARD_PATHS = new Set(['/card', '/card/qr']);

export default defineConfig({
  site: 'https://mjrossi.com',
  output: 'server',
  integrations: [
    mdx(),
    // /admin is the Desk: a sitemap entry would hand crawlers the slug of every
    // draft. Filtered through the same isAdminPath as the middleware gate.
    //
    // /card and /card/qr are utility pages, not content. /card stays indexable
    // (just not advertised); /card/qr is also noindexed.
    sitemap({
      filter: (page) => {
        const { pathname } = new URL(page);
        return !isAdminPath(pathname) && !CARD_PATHS.has(pathname.replace(/\/$/, ''));
      },
    }),
  ],
  // Names the processor. Astro's default `satteri()` runs no remark plugins,
  // so a post would render perfectly with no `data-src` anchors and the galley
  // would silently stop working. This used to work only via a deprecated shim
  // that swapped in `unified()` when it saw legacy `remarkPlugins`. @astrojs/mdx
  // 8 delegates .mdx to this same processor, so one declaration covers both.
  markdown: {
    processor: unified({ remarkPlugins: [remarkSourceAnchors] }),
  },
  adapter: cloudflare({ imageService: 'compile' }),
  fonts: [
    {
      provider: fontProviders.google(),
      name: 'Inter',
      cssVariable: '--font-inter',
      weights: [400, 500, 600, 700],
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
    // The build instant, inlined. BlogPost.astro asks "was this post published
    // when make-post-og.mjs ran?" — which posts have a card — not "is it
    // published now?". make-post-og runs after astro build, so every advertised
    // card was written.
    define: {
      __BUILD_TIME__: JSON.stringify(Date.now()),
    },
    build: {
      rollupOptions: {
        output: {
          // Astro's `@_@` chunk names 307 to their percent-encoded form on the
          // Static Assets binding (~337ms on the LCP path), so `@` becomes `-`.
          // Other assets keep default names, which smoke looks for.
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
