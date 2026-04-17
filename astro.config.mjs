import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  site: 'https://mjrossi.com',
  output: 'static',
  integrations: [sitemap()],
});
