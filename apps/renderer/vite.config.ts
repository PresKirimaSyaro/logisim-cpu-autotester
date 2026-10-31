import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));

export default defineConfig({
  root,
  base: './',
  plugins: [react()],
  build: {
    outDir: resolve(root, '../../dist/renderer'),
    emptyOutDir: true,
    target: 'chrome120',
  },
});
