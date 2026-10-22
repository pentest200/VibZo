import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { browserEndpoints } from './endpoints.js';
process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= resolve('.cache/ms-playwright');
process.env['E2E_DATABASE'] ??= `chat_e2e_auth_${randomUUID().replaceAll('-','')}`;
process.env['E2E_RUN_ID'] ??= randomUUID();
const ports = browserEndpoints();
const env = { NODE_ENV: 'test', MONGODB_DATABASE: process.env['E2E_DATABASE'], WEB_ORIGIN: ports.origin, API_PORT: String(ports.api), GATEWAY_PORT: String(ports.gateway), WORKER_PORT: String(ports.worker), WEB_DEV_PORT: String(ports.web) };
export default defineConfig({
  testDir: '.', testMatch: 'auth.spec.ts', fullyParallel: false, workers: 1, retries: 0, timeout: 60000,
  globalSetup: './setup.ts', outputDir: resolve('.cache/e2e-results'), reporter: [['list'], ['./cleanup-reporter.ts']],
  use: { baseURL: ports.origin, headless: true, viewport: { width: 1280, height: 900 } },
  webServer: [
    { command: 'node apps/api/dist/main.js', cwd: resolve('.'), url: `http://127.0.0.1:${ports.api}/health/live`, env, reuseExistingServer: false, timeout: 60000 },
    { command: 'node apps/worker/dist/main.js', cwd: resolve('.'), url: `http://127.0.0.1:${ports.worker}/health/live`, env, reuseExistingServer: false, timeout: 60000 },
    { command: 'node apps/gateway/dist/main.js', cwd: resolve('.'), url: `http://127.0.0.1:${ports.gateway}/health/live`, env, reuseExistingServer: false, timeout: 60000 },
    { command: 'pnpm --filter @chat/web dev', cwd: resolve('.'), url: ports.origin, env, reuseExistingServer: false, timeout: 60000 }
  ]
});
