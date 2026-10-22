import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';
const liveBuffer = Number(process.env['VITE_LIVE_BUFFER_EVENTS'] ?? '256');
if (!Number.isInteger(liveBuffer) || liveBuffer < 1 || liveBuffer > 256) throw new Error('VITE_LIVE_BUFFER_EVENTS must be an integer from 1 to 256');
const icePolicy = process.env['VITE_ICE_TRANSPORT_POLICY'] ?? 'all';
if (!['all', 'relay'].includes(icePolicy)) throw new Error('VITE_ICE_TRANSPORT_POLICY must be all or relay');
const ports = ['WEB_DEV_PORT', 'API_PORT', 'GATEWAY_PORT'].map((key, index) => Number(process.env[key] ?? [5173, 3000, 3001][index])) as [number, number, number];
if (new Set(ports).size !== 3 || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('Invalid development server ports');
export default defineConfig({
  define: { 'import.meta.env.VITE_LIVE_BUFFER_EVENTS': JSON.stringify(liveBuffer), 'import.meta.env.VITE_ICE_TRANSPORT_POLICY': JSON.stringify(icePolicy) },
  plugins: [react(), tailwind()],
  server: { host: '127.0.0.1', strictPort: true, port: ports[0], proxy: {
    '/socket.io': { target: `http://127.0.0.1:${ports[2]}`, ws: true },
    '/health': `http://127.0.0.1:${ports[1]}`, '/api': `http://127.0.0.1:${ports[1]}`
  } }
});
