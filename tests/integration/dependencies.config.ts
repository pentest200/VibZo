import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/integration/dependencies.failure.test.ts'], testTimeout: 180000, hookTimeout: 120000, fileParallelism: false } });
