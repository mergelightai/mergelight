import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { '@': decodeURIComponent(new URL('./src', import.meta.url).pathname) } },
  // The setup page uses the real workflow files from examples/, one level up.
  server: { fs: { allow: ['..'] } },
  build: {
    rollupOptions: {
      input: { main: 'index.html', setup: 'setup/index.html', dashboard: 'dashboard/index.html' },
    },
  },
});
