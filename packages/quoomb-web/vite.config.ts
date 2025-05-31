import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],

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
