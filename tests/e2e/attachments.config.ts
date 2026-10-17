import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';
export default defineConfig({ ...base, testMatch: 'attachments.spec.ts', timeout: 120000, use: { ...base.use, screenshot: 'only-on-failure', trace: 'retain-on-failure' } });
