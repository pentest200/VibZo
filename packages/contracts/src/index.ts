import { z } from 'zod';

import { idSchema, sequenceSchema } from './primitives.js';
export * from './primitives.js';
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
export { acceptedReferenceSchema as acceptedMessageSchema } from './messaging.js';
export const problemSchema = z.strictObject({
  code: z.enum(['UNAUTHENTICATED', 'FORBIDDEN', 'INVALID_INPUT', 'CONFLICT', 'CURSOR_EXPIRED', 'RATE_LIMITED', 'UNAVAILABLE']),
  message: z.string().max(200), requestId: idSchema, retryable: z.boolean()
});
export const readinessSchema = z.strictObject({
  status: z.enum(['ready', 'unavailable']), service: z.literal('api'), phase: z.literal('foundation'),
  dependencies: z.strictObject({ mongodb: z.enum(['up', 'down']) })
});
export * from './auth.js';
export * from './conversations.js';
export * from './messaging.js';
