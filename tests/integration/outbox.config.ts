import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/integration/outbox.failure.test.ts'], testTimeout: 120000, hookTimeout: 60000, fileParallelism: false } });
