import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import base from './playwright.config.js';
const servers = Array.isArray(base.webServer) ? base.webServer : [];
const proxyUrl = new URL(process.env['REDIS_URL'] ?? 'redis://:local-only-redis-password@127.0.0.1:6379'); proxyUrl.hostname = '127.0.0.1'; proxyUrl.port = '16380';
export default defineConfig({ ...base, testMatch: 'sync.spec.ts', use: { ...base.use, trace: 'retain-on-failure', screenshot: 'only-on-failure' }, timeout: 120000,
  webServer: [
    { command: 'node tests/fixtures/redis-drop-proxy.mjs', cwd: resolve('.'), url: 'http://127.0.0.1:16381/health', env: { NODE_ENV: 'test' }, reuseExistingServer: false },
    ...servers.map(server => server.command.includes('apps/worker/') ? { ...server, env: { ...server.env, REDIS_URL: proxyUrl.toString() } } : server.command.includes('@chat/web') ? { ...server, env: { ...server.env, VITE_LIVE_BUFFER_EVENTS: '8' } } : server)
  ]
});
