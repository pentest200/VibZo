import { defineConfig } from '@playwright/test';
import base from './calls.config.js';
process.env['CALL_TEST_RELAY'] = 'true';
const servers = Array.isArray(base.webServer) ? base.webServer : [];
export default defineConfig({ ...base, grep: /two independent users/,
  // The existing fake-device UI flag supplies capture consent. Chromium's
  // explicit media-permission overrides stall loopback TURN allocation on this
  // pinned Windows browser; retain native ICE/relay assertions below.
  use: { ...base.use, permissions: [] },
  webServer: servers.map(server => ({ ...server, env: { ...server.env, VITE_ICE_TRANSPORT_POLICY: 'relay' } }))
});
