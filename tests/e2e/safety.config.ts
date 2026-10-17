import { createECDH } from 'node:crypto';
import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
const key = createECDH('prime256v1'); key.generateKeys();
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, testMatch: 'safety.spec.ts', timeout: 120000, use: { ...base.use, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: servers.map(server => ({ ...server, env: { ...server.env, PUSH_ENABLED: 'true', VAPID_PUBLIC_KEY: key.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: key.getPrivateKey().toString('base64url') } }))
});
