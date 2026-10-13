import { z } from 'zod';

export const MAX_SEQUENCE = 9223372036854775807n;
export const sequenceSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(value => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= MAX_SEQUENCE, 'Sequence exceeds signed 64-bit range');
export type Sequence = z.infer<typeof sequenceSchema>;
export function compareSequences(a: Sequence, b: Sequence): -1 | 0 | 1 {
  const left = BigInt(sequenceSchema.parse(a));
  const right = BigInt(sequenceSchema.parse(b));
  return left < right ? -1 : left > right ? 1 : 0;
}

export const idSchema = z.uuid();
export const messageTextSchema = z.string().refine(text => {
  const size = Array.from(text).length;
  return size > 0 && size <= 4000 && text.trim().length > 0;
}, 'Message must contain 1–4000 Unicode code points');
export const sendMessageSchema = z.strictObject({
  v: z.literal(1), conversationId: idSchema, clientMessageId: idSchema,
  text: messageTextSchema, replyToId: idSchema.optional(), attachmentIds: z.array(idSchema).max(8).default([])
});
export type SendMessage = z.infer<typeof sendMessageSchema>;

export const messageCreatedSchema = z.strictObject({
  messageId: idSchema, senderId: idSchema, clientMessageId: idSchema,
  creationSequence: sequenceSchema, text: messageTextSchema
});
export const eventSchema = z.strictObject({
  v: z.literal(1), eventId: idSchema, conversationId: idSchema, sequence: sequenceSchema,
  kind: z.literal('message.created'), payload: messageCreatedSchema
});
export const acceptedMessageSchema = z.strictObject({
  status: z.literal('accepted'), message: messageCreatedSchema
});
export const problemSchema = z.strictObject({
  code: z.enum(['UNAUTHENTICATED', 'FORBIDDEN', 'INVALID_INPUT', 'CONFLICT', 'CURSOR_EXPIRED', 'RATE_LIMITED', 'UNAVAILABLE']),
  message: z.string().max(200), requestId: idSchema, retryable: z.boolean()
});
export const readinessSchema = z.strictObject({
  status: z.enum(['ready', 'unavailable']), service: z.literal('api'), phase: z.literal('foundation'),
  dependencies: z.strictObject({ mongodb: z.enum(['up', 'down']) })
});
export * from './auth.js';
