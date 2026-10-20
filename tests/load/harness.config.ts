import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { include: ['tests/load/harness.test.ts'], testTimeout: 10000 } });
