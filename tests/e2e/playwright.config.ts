import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= resolve('.cache/ms-playwright');
process.env['E2E_DATABASE'] ??= `chat_e2e_auth_${randomUUID().replaceAll('-','')}`;
const env = { NODE_ENV: 'test', MONGODB_DATABASE: process.env['E2E_DATABASE'], WEB_ORIGIN: 'http://localhost:5173' };
export default defineConfig({
  testDir: '.', testMatch: 'auth.spec.ts', fullyParallel: false, workers: 1, retries: 0, timeout: 60000,
  globalSetup: './setup.ts', outputDir: resolve('.cache/e2e-results'), reporter: 'list',
  use: { baseURL: 'http://localhost:5173', headless: true, viewport: { width: 1280, height: 900 } },
  webServer: [
    { command: 'node apps/api/dist/main.js', cwd: resolve('.'), url: 'http://127.0.0.1:3000/health/live', env, reuseExistingServer: false, timeout: 60000 },
    { command: 'node apps/worker/dist/main.js', cwd: resolve('.'), url: 'http://127.0.0.1:3002/health/live', env, reuseExistingServer: false, timeout: 60000 },
    { command: 'node apps/gateway/dist/main.js', cwd: resolve('.'), url: 'http://127.0.0.1:3001/health/live', env, reuseExistingServer: false, timeout: 60000 },
    { command: 'pnpm --filter @chat/web dev', cwd: resolve('.'), url: 'http://localhost:5173', env, reuseExistingServer: false, timeout: 60000 }
  ]
});
