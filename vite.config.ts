import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: 'dist',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    // The app writes runtime data (localStorage leveldb, atomic-save *.tmp) into
    // DataLocation/ inside the repo. Watching it crashes the watcher with EBUSY
    // when a save happens mid-watch — and there is nothing to hot-reload here.
    watch: {
      ignored: ['**/DataLocation/**'],
    },
  },
});
