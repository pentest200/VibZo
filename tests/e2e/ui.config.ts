import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
import { resolve } from 'node:path';
export default defineConfig({ ...base, testMatch: 'ui.spec.ts', outputDir: resolve('.cache/ui-results'), timeout: 120000, use: { ...base.use, trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
