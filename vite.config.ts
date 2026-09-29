import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Relative base so the build works from any static host path (GitHub Pages, Netlify, S3…).
export default defineConfig({
  base: './',
  plugins: [react()],
  build: { chunkSizeWarningLimit: 900 },
  test: { include: ['tests/**/*.test.ts'] },
} as never);
