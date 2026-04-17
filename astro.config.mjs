// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';
import sitemap from '@astrojs/sitemap';

export default defineConfig({
  output: 'static',
  site: 'https://real.bellotreno.org',

  vite: {
    plugins: [tailwindcss()],
  },

  integrations: [
    sitemap({
      // 单 URL 多语言，无需 i18n 路由，直接列出所有页面
      filter: (page) => !page.includes('/_'),
    }),
  ],
});