import { z } from 'zod';
import { idSchema, sequenceSchema } from './primitives.js';
import { usernameSchema } from './auth.js';
const pageLimit = z.coerce.number().int().min(1).max(100).default(50);
export const searchQuerySchema = z.strictObject({ prefix: z.string().min(3).max(24).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).transform(value => value.toLowerCase()),
  after: usernameSchema.optional(), limit: z.coerce.number().int().min(1).max(30).default(20) });
export const directCreateSchema = z.strictObject({ targetUserId: idSchema });
export const groupCreateSchema = z.strictObject({ clientCommandId: idSchema, title: z.string().trim().min(1).max(80) });
export const inviteSchema = z.strictObject({ targetUserId: idSchema });
export const roleSchema = z.strictObject({ role: z.enum(['admin','member']) });
export const transferSchema = z.strictObject({ targetUserId: idSchema });
export const titleSchema = z.strictObject({ title: z.string().trim().min(1).max(80) });
export const inboxQuerySchema = z.strictObject({ after: idSchema.optional(), limit: pageLimit });
export const feedQuerySchema = z.strictObject({ after: sequenceSchema.default('0'), through: sequenceSchema.optional(), limit: pageLimit });
export const historyQuerySchema = z.strictObject({ before: sequenceSchema.optional(), through: sequenceSchema.optional(), limit: pageLimit });
export const publicUserSchema = z.strictObject({ id: idSchema, username: usernameSchema, displayName: z.string().max(60), avatarId: idSchema.nullable() });
export const searchResultSchema = z.strictObject({ users: z.array(publicUserSchema).max(30), nextCursor: usernameSchema.nullable() });
export const inboxItemSchema = z.strictObject({ id: idSchema, kind: z.enum(['direct','group']), title: z.string().max(80),
  state: z.enum(['active','invited']), role: z.enum(['owner','admin','member']), otherUserId: idSchema.nullable(), updatedAt: z.iso.datetime() });
export const inboxSnapshotSchema = z.strictObject({ items: z.array(inboxItemSchema).max(100), nextCursor: idSchema.nullable(), watermark: sequenceSchema });
export const inboxFeedSchema = z.strictObject({ events: z.array(z.strictObject({ eventId: idSchema, conversationId: idSchema.nullable(), sequence: sequenceSchema,
  kind: z.enum(['conversation.changed','blocks.changed']) })).max(100), nextCursor: sequenceSchema, watermark: sequenceSchema, hasMore: z.boolean() });
export const memberSchema = z.strictObject({ user: publicUserSchema, role: z.enum(['owner','admin','member']), state: z.enum(['active','invited']), invitationExpiresAt: z.iso.datetime().nullable() });
export const conversationSchema = z.strictObject({ id: idSchema, kind: z.enum(['direct','group']), title: z.string().max(80),
  role: z.enum(['owner','admin','member']), members: z.array(memberSchema).max(50), watermark: sequenceSchema, blocked: z.boolean(), otherUserId: idSchema.nullable() });
export const createdConversationSchema = z.strictObject({ conversationId: idSchema });
export const historySchema = z.strictObject({ messages: z.array(z.strictObject({ id: idSchema, senderId: idSchema, creationSequence: sequenceSchema,
  text: z.string().max(8000), replyToId: idSchema.nullable().default(null), deleted: z.boolean(), createdAt: z.iso.datetime() })).max(100), nextCursor: sequenceSchema.nullable(), watermark: sequenceSchema });
export const blocksQuerySchema = z.strictObject({ after: idSchema.optional(), limit: pageLimit });
export const blocksSchema = z.strictObject({ users: z.array(publicUserSchema).max(100), nextCursor: idSchema.nullable() });
export type Conversation = z.infer<typeof conversationSchema>;
export type InboxSnapshot = z.infer<typeof inboxSnapshotSchema>;
export type PublicUser = z.infer<typeof publicUserSchema>;
