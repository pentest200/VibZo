import { z } from 'zod';
import { attachmentReferenceSchema } from './attachments.js';
import { idSchema, sequenceSchema } from './primitives.js';
import { brokerEventSchema } from './messaging.js';
import { inboxItemSchema } from './conversations.js';
export const socketAuthSchema = z.strictObject({ csrf: z.string().min(20).max(128) });
export const subscriptionSchema = z.strictObject({ conversationId: idSchema });
export const typingSchema = subscriptionSchema.extend({ active: z.boolean() });
export const presenceQuerySchema = subscriptionSchema.extend({ targetUserId: idSchema });
export const reactionSchema = z.enum(['like', 'heart', 'laugh', 'surprise', 'sad', 'thanks']);
export const mutationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('edit'), commandId: idSchema, conversationId: idSchema, messageId: idSchema, expectedVersion: sequenceSchema, text: z.string().min(1).max(8000) }),
  z.strictObject({ kind: z.literal('delete'), commandId: idSchema, conversationId: idSchema, messageId: idSchema, expectedVersion: sequenceSchema }),
  z.strictObject({ kind: z.literal('reaction'), commandId: idSchema, conversationId: idSchema, messageId: idSchema, reaction: reactionSchema, active: z.boolean() }),
  z.strictObject({ kind: z.literal('receipt'), commandId: idSchema, conversationId: idSchema, appliedFrom: sequenceSchema, delivered: sequenceSchema, read: sequenceSchema })
]);
export type MessageMutation = z.infer<typeof mutationSchema>;
export const mutationResultSchema = z.strictObject({ status: z.literal('accepted'), sequence: sequenceSchema });
export const syncMessageSchema = z.strictObject({ id: idSchema, senderId: idSchema, clientMessageId: idSchema, creationSequence: sequenceSchema, version: sequenceSchema,
  attachments: z.array(attachmentReferenceSchema).max(8).default([]), text: z.string().max(8000), replyToId: idSchema.nullable(), deleted: z.boolean(), createdAt: z.iso.datetime(),
  reactions: z.array(z.strictObject({ reaction: reactionSchema, count: z.number().int().min(0).max(50), mine: z.boolean() })).max(6) });
export type SyncMessage = z.infer<typeof syncMessageSchema>;
export const receiptSchema = z.strictObject({ userId: idSchema, delivered: sequenceSchema, deliveredFrom: sequenceSchema, read: sequenceSchema, visibleFrom: sequenceSchema });
export const conversationSnapshotSchema = z.strictObject({ conversationId: idSchema, watermark: sequenceSchema, messages: z.array(syncMessageSchema).max(100),
  receipts: z.array(receiptSchema).max(50), olderBefore: sequenceSchema.nullable(), capturedAt: z.iso.datetime() });
export type ConversationSnapshot = z.infer<typeof conversationSnapshotSchema>;
export const replayQuerySchema = z.strictObject({ after: sequenceSchema.default('0'), through: sequenceSchema.optional(), limit: z.coerce.number().int().min(1).max(100).default(100) });
export const replayResultSchema = z.strictObject({ events: z.array(brokerEventSchema).max(100), nextCursor: sequenceSchema, watermark: sequenceSchema, hasMore: z.boolean() });
export type ReplayResult = z.infer<typeof replayResultSchema>;
export const snapshotCreateSchema = z.strictObject({ kind: z.enum(['inbox', 'conversation']), conversationId: idSchema.optional() }).refine(input => input.kind === 'conversation' ? !!input.conversationId : !input.conversationId);
export const snapshotTicketSchema = z.strictObject({ id: idSchema, watermark: sequenceSchema, expiresAt: z.iso.datetime() });
export const snapshotPageQuerySchema = z.strictObject({ page: z.coerce.number().int().min(0).max(10).default(0) });
export const snapshotPageSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('inbox'), watermark: sequenceSchema, data: z.array(inboxItemSchema.extend({ unread: z.number().int().min(0).max(1000) })).max(100), nextPage: z.number().int().nullable() }),
  z.strictObject({ kind: z.literal('conversation'), watermark: sequenceSchema, data: conversationSnapshotSchema, nextPage: z.null() })
]);
export type SnapshotPage = z.infer<typeof snapshotPageSchema>;
export const liveHintSchema = z.discriminatedUnion('kind', [z.strictObject({ kind: z.literal('conversation'), conversationId: idSchema }), z.strictObject({ kind: z.literal('inbox') })]);
export type LiveHint = z.infer<typeof liveHintSchema>;

export const historyWindowQuerySchema = z.strictObject({ before: sequenceSchema.optional() });

export interface SyncInbox { items: Extract<SnapshotPage, { kind: 'inbox' }>['data']; watermark: string }
