import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
import { resolve } from 'node:path';
export default defineConfig({ ...base, testMatch: 'a11y.spec.ts', outputDir: resolve('.cache/a11y-results'), timeout: 120000, use: { ...base.use, trace: 'retain-on-failure', screenshot: 'only-on-failure' } });
