import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import calls from '../e2e/calls.config.js';
import { argumentsFor } from './policy.js';
argumentsFor([process.env['LOAD_MODE'] ?? '', process.env['LOAD_PROFILE'] ?? '']);
if (!process.env['LOAD_DIRECTORY'] || !process.env['UPGRADE_MEDIA_NAME']) throw new Error('Use test:load:* to provision owned fixtures');
export default defineConfig({ ...calls, testDir: '.', testMatch: 'load.spec.ts', timeout: 300000, workers: 1, retries: 0,
  globalSetup: resolve('tests/e2e/setup.ts'), reporter: [['list'], [resolve('tests/e2e/cleanup-reporter.ts')]],
  outputDir: resolve(process.env['LOAD_DIRECTORY'], 'browser'), use: { ...calls.use, trace: 'off', screenshot: 'only-on-failure' },
});
