import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    // En desarrollo la API (wrangler dev) se sirve bajo el mismo origen: las cookies httpOnly funcionan sin CORS.
    proxy: { '/v1': { target: process.env.API_URL ?? 'http://127.0.0.1:8787', changeOrigin: false } },
  },
  build: { outDir: 'dist', sourcemap: false },
});
