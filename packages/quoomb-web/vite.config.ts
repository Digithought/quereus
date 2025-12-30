import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],

  resolve: {
    alias: [
      // Redirect @quereus/plugin-store to browser-only entry point
      // This prevents LevelDB (Node.js-only) from being bundled
      // Order matters: more specific paths first
      {
        find: '@quereus/plugin-store/browser',
        replacement: resolve(__dirname, '../quereus-plugin-store/dist/src/browser.js'),
      },
      {
        find: '@quereus/plugin-store',
        replacement: resolve(__dirname, '../quereus-plugin-store/dist/src/browser.js'),
      },
    ],
  },

  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        worker: resolve(__dirname, 'src/worker/quereus.worker.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'worker') {
            return 'worker/[name].[hash].js';
          }
          return 'assets/[name].[hash].js';
        },
      },
    },
  },

  worker: {
    format: 'es',
    plugins: () => [react()],
  },

  optimizeDeps: {
    exclude: ['@quereus/engine'],
  },

  server: {
    port: 3000,
    host: true,
  },

  preview: {
    port: 3001,
    host: true,
  },

  define: {
    global: 'globalThis',
  },
});
