import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // In dev the client calls relative /api/... URLs and Vite forwards them
    // to the Express server, so no CORS or hard-coded API host is needed.
    proxy: {
      '/api': 'http://localhost:4000',
    },
  },
});
