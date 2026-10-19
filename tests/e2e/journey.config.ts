import { defineConfig } from '@playwright/test';
import base from './calls.config.js';
import { resolve } from 'node:path';
if (!process.env['UPGRADE_MEDIA_NAME']) throw new Error('Use test:e2e:journey to provision the isolated provider');
// One bounded journey combines several existing individually bounded workflows.
export default defineConfig({ ...base, testMatch: 'journey.spec.ts', outputDir: resolve('.cache/journey-results'), timeout: 300000, use: { ...base.use, trace: 'retain-on-failure' } });
