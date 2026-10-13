import { describe, expect, it } from 'vitest';
import { compareSequences, MAX_SEQUENCE, messageTextSchema, sendMessageSchema, sequenceSchema } from './index.js';

describe('exact wire sequences', () => {
  it('orders beyond Number precision and preserves JSON string values', () => {
    expect(compareSequences('9007199254740992', '9007199254740993')).toBe(-1);
    expect(JSON.parse(JSON.stringify({ sequence: MAX_SEQUENCE.toString() }))).toEqual({ sequence: '9223372036854775807' });
  });
  it.each(['01', '-1', '1.1', '1e3', ' 1', '9223372036854775808', '9'.repeat(100)])('rejects invalid sequence %s', value => {
    expect(sequenceSchema.safeParse(value).success).toBe(false);
  });
  it('rejects attacker sender identity and numeric cursors', () => {
    expect(sendMessageSchema.safeParse({ v: 1, conversationId: crypto.randomUUID(), clientMessageId: crypto.randomUUID(), text: 'Hi', senderId: crypto.randomUUID() }).success).toBe(false);
    expect(sequenceSchema.safeParse(1).success).toBe(false);
  });
  it('uses Unicode code points and disallows empty/oversize messages', () => {
    expect(messageTextSchema.safeParse('🙂'.repeat(4000)).success).toBe(true);
    expect(messageTextSchema.safeParse('🙂'.repeat(4001)).success).toBe(false);
    expect(messageTextSchema.safeParse('  \n ').success).toBe(false);
  });
});
