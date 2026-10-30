import path from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const root = import.meta.dirname;

// Preload the fonts the first screen paints with: the latin subset of the display, body and mono faces.
// Picked from the bundle, so only files that exist in this build are linked (hashed names change per build).
const ABOVE_THE_FOLD = [/^fraunces-latin-full-normal-.*\.woff2$/, /^bricolage-grotesque-latin-wght-normal-.*\.woff2$/, /^jetbrains-mono-latin-wght-normal-.*\.woff2$/];
function preloadFonts() {
  return {
    name: 'preload-above-the-fold-fonts',
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        const names = Object.keys((ctx && ctx.bundle) || {}).map(f => f.replace(/^assets\//, ''));
        const tags = ABOVE_THE_FOLD.map(re => names.find(n => re.test(n))).filter(Boolean).map(n => (
          { tag: 'link', attrs: { rel: 'preload', as: 'font', type: 'font/woff2', crossorigin: '', href: './assets/' + n }, injectTo: 'head' }));
        return tags;
      }
    }
  };
}

const vendor = [['react', /node_modules[\/](react|react-dom|scheduler)[\/]/], ['motion', /node_modules[\/](motion|framer-motion|motion-dom|motion-utils)[\/]/],
  ['lucide', /node_modules[\/]lucide-react[\/]/], ['radix', /node_modules[\/](@radix-ui|radix-ui)[\/]/]];

// The panel lives in web/. `node tools/build.js` runs this build, then writes config.js and _headers beside it.
export default defineConfig({
  root: path.join(root, 'web'),
  base: './',
  plugins: [react(), tailwind(), preloadFonts()],
  resolve: { alias: { '@': path.join(root, 'web/src'), '@core': path.join(root, 'src/core') } },
  build: {
    outDir: path.join(root, 'dist'),
    emptyOutDir: false,
    rollupOptions: { output: { manualChunks(id) { const v = vendor.find(([, re]) => re.test(id)); return v ? v[0] : undefined; } } },
    commonjsOptions: { include: [/node_modules/, /src[\/]core[\/]util\.js$/] }
  }
});
