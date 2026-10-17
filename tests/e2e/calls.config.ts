import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: 'calls.spec.ts', timeout: 120000,
  use: { ...base.use, permissions: ['microphone', 'camera'], screenshot: 'only-on-failure',
    launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen'] } },
  webServer: servers.map(server => ({ ...server, env: { ...server.env, CALLS_ENABLED: 'true' } }))
});
