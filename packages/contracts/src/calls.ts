import { z } from 'zod';
import { idSchema } from './primitives.js';
export const startCallSchema = z.strictObject({ commandId: idSchema, conversationId: idSchema, mode: z.enum(['voice', 'video']) });
export const callActionSchema = z.strictObject({ commandId: idSchema, action: z.enum(['accept', 'decline', 'cancel', 'leave', 'end', 'remove']), targetUserId: idSchema.optional() });
export const callParticipantSchema = z.strictObject({ userId: idSchema, displayName: z.string().max(60), state: z.enum(['invited', 'accepted', 'declined', 'left', 'removed']), joined: z.boolean(), currentDevice: z.boolean() });
export const callSchema = z.strictObject({
  id: idSchema, conversationId: idSchema, creatorId: idSchema, title: z.string().max(80), mode: z.enum(['voice', 'video']),
  state: z.enum(['ringing', 'active', 'ending', 'ended', 'cancelled', 'declined', 'timed_out']),
  generation: z.number().int().positive(), ready: z.boolean(), reason: z.string().max(80),
  createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), ringUntil: z.iso.datetime(),
  participants: z.array(callParticipantSchema).max(50), canEnd: z.boolean(), canRemove: z.boolean()
});
export type CallView = z.infer<typeof callSchema>;
export const callListSchema = z.array(callSchema).max(20);
export const callStatusSchema = z.strictObject({ enabled: z.boolean(), available: z.boolean() });
export const joinCallSchema = z.strictObject({ token: z.string().max(8192), url: z.url(), identity: z.string().max(100), generation: z.number().int().positive(), expiresAt: z.iso.datetime() });
