import { defineConfig } from '@playwright/test';
import calls from './calls.config.js';
if (!process.env['UPGRADE_MEDIA_NAME']) throw new Error('Use test:e2e:upgrade to provision the isolated provider');
export default defineConfig({ ...calls, testMatch: 'upgrade.spec.ts', timeout: 180000, use: { ...calls.use, trace: 'retain-on-failure' } });
