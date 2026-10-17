import { z } from 'zod';
import { idSchema, sequenceSchema } from './primitives.js';
export const controlKindSchema = z.enum(['conversation.created', 'conversation.renamed', 'member.invited', 'member.joined', 'member.declined', 'member.role_changed', 'owner.transferred', 'member.left', 'member.removed', 'member.invitation_expired']);
export const durableKindSchema = z.union([controlKindSchema, z.enum(['message.created', 'message.edited', 'message.deleted', 'reaction.changed', 'receipt.changed', 'call.created', 'call.updated', 'call.ended'])]);
// Broker and projection references contain no body; recipients must authorize before fetching content.
export const brokerEventSchema = z.strictObject({ v: z.literal(1), eventId: idSchema, conversationId: idSchema, sequence: sequenceSchema, kind: durableKindSchema });
export type BrokerEvent = z.infer<typeof brokerEventSchema>;
export const acceptedReferenceSchema = z.strictObject({ status: z.literal('accepted'), eventId: idSchema,
  message: z.strictObject({ messageId: idSchema, senderId: idSchema, clientMessageId: idSchema, creationSequence: sequenceSchema }) });
export type AcceptedMessage = z.infer<typeof acceptedReferenceSchema>;
