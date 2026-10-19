import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/integration/restore-format.test.ts', 'tests/integration/restore.test.ts'], fileParallelism: false, testTimeout: 180000, hookTimeout: 180000 } });
