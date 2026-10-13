import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '.cache/**', '.pnpm-store/**', '**/coverage/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: { '@typescript-eslint/no-explicit-any': 'error', '@typescript-eslint/consistent-type-imports': 'error' }
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { patterns: ['@chat/domain', '@chat/config', '@chat/observability', 'mongodb', 'node:*', 'livekit-server-sdk'] }] }
  }
);
