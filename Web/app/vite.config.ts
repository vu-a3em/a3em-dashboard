import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Served from a subpath alongside the existing A3EM site; a relative base keeps the
  // build working wherever it is mounted.
  base: './',
  build: { outDir: 'dist', sourcemap: true },
});
