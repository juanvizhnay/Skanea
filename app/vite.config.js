/* global __dirname */
/* eslint-env node */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteStaticCopy } from 'vite-plugin-static-copy';
import { resolve } from 'path';

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        { src: 'resources/**/*', dest: 'resources' },
        { src: 'manifest.json', dest: '.' },
        { src: 'background.js', dest: '.' }
      ]
    })
  ],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/popup.html'),
      },
    },
    outDir: 'dist',
    emptyOutDir: true
  }
});

