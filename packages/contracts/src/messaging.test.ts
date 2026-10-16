import { expect, it } from 'vitest';
import { brokerEventSchema, acceptedReferenceSchema } from './messaging.js';
const randomUUID = () => crypto.randomUUID();
it('validates versioned control/message references without bodies or numeric sequence coercion', () => {
  const reference = { v: 1, eventId: randomUUID(), conversationId: randomUUID(), sequence: '9007199254740993', kind: 'member.removed' };
  expect(brokerEventSchema.parse(reference)).toEqual(reference);
  expect(brokerEventSchema.safeParse({ ...reference, kind: 'message.created' }).success).toBe(true);
  expect(brokerEventSchema.safeParse({ ...reference, text: 'private body' }).success).toBe(false);
  expect(brokerEventSchema.safeParse({ ...reference, v: 2 }).success).toBe(false);
  expect(brokerEventSchema.safeParse({ ...reference, sequence: 1 }).success).toBe(false);
  expect(brokerEventSchema.safeParse({ ...reference, kind: 'arbitrary.effect' }).success).toBe(false);
});
it('acceptance reports stable references without asserting delivery or retaining edited content', () => {
  const accepted = { status: 'accepted', eventId: randomUUID(), message: { messageId: randomUUID(), senderId: randomUUID(), clientMessageId: randomUUID(), creationSequence: '2' } };
  expect(acceptedReferenceSchema.parse(accepted)).toEqual(accepted);
  expect(acceptedReferenceSchema.safeParse({ ...accepted, status: 'delivered' }).success).toBe(false);
  expect(acceptedReferenceSchema.safeParse({ ...accepted, message: { ...accepted.message, text: 'original' } }).success).toBe(false);
});
