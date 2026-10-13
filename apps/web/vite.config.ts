import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwind()],
  server: { host: '127.0.0.1', strictPort: true, port: 5173, proxy: {
    '/health': 'http://127.0.0.1:3000', '/api': 'http://127.0.0.1:3000'
  } }
});
