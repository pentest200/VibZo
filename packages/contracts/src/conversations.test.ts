import { expect, it } from 'vitest';
import { directCreateSchema, groupCreateSchema, roleSchema, searchQuerySchema, feedQuerySchema, historyQuerySchema } from './conversations.js';
const id = '0359034d-42a2-4fd4-b1d3-74f014a4c0d0';
it('rejects caller identity and owner-role injection in conversation commands', () => {
  expect(directCreateSchema.safeParse({ targetUserId: id, senderId: id }).success).toBe(false);
  expect(roleSchema.safeParse({ role: 'owner' }).success).toBe(false);
  expect(groupCreateSchema.parse({ clientCommandId: id, title: ' Team ' }).title).toBe('Team');
  expect(groupCreateSchema.safeParse({ clientCommandId: id, title: ' ' }).success).toBe(false);
});
it('bounds search and exact cursor inputs without floating-point coercion', () => {
  expect(searchQuerySchema.parse({ prefix: 'ALI' }).prefix).toBe('ali');
  for (const prefix of ['ab', '.*x', 'a'.repeat(25)]) expect(searchQuerySchema.safeParse({ prefix }).success).toBe(false);
  expect(searchQuerySchema.safeParse({ prefix: 'alice', limit: 31 }).success).toBe(false);
  expect(feedQuerySchema.parse({ after: '9007199254740993' }).after).toBe('9007199254740993');
  expect(feedQuerySchema.safeParse({ after: '01' }).success).toBe(false);
  expect(historyQuerySchema.safeParse({ before: 123 }).success).toBe(false);
  expect(historyQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
});
