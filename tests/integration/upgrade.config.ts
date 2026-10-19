import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/integration/upgrade.test.ts'], testTimeout: 120000, hookTimeout: 360000, fileParallelism: false } });
