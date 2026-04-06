import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html')
      }
    }
  },
  server: {
    port: 5173,
    host: true
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'public/src/Skanea-frontend/src'),
      'src': resolve(__dirname, 'public/src/Skanea-frontend/src')
    }
  },
  publicDir: 'public/src/Skanea-frontend/public'
});
