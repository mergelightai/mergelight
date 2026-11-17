import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { docsPlugin, writeDocs } from './docgen/build.ts';

const root = decodeURIComponent(new URL('.', import.meta.url).pathname);

export default defineConfig(async () => {
  // The docs pages are made from the Markdown files in docs/, one level up, before Vite builds them.
  const docs = await writeDocs(root);
  return {
    plugins: [react(), tailwindcss(), docsPlugin(root)],
    resolve: { alias: { '@': `${root}src` } },
    // The setup page uses the real workflow files from examples/, and the docs pages the files in docs/, one level up.
    server: { fs: { allow: ['..'] } },
    build: {
      rollupOptions: {
        input: { main: 'index.html', setup: 'setup/index.html', dashboard: 'dashboard/index.html', privacy: 'privacy/index.html', ...docs },
      },
    },
  };
});
