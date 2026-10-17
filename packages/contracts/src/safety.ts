import { z } from 'zod';
import { idSchema } from './primitives.js';
export const pushSubscriptionSchema = z.strictObject({
  endpoint: z.url().max(2048), expirationTime: z.number().int().positive().nullable().optional(),
  keys: z.strictObject({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/) })
});
export type DeviceSubscription = z.infer<typeof pushSubscriptionSchema>;
export const notificationPreferenceSchema = z.strictObject({ enabled: z.boolean() });
export const notificationSettingsSchema = z.strictObject({ enabled: z.boolean(), subscribed: z.boolean(), available: z.boolean(), publicKey: z.string(), expiresAt: z.iso.datetime().nullable() });
export const reportInputSchema = z.strictObject({ commandId: idSchema, conversationId: idSchema, messageId: idSchema.nullable(), reason: z.enum(['spam', 'harassment', 'unsafe', 'other']) });
export const reportSchema = reportInputSchema.omit({ commandId: true }).extend({ id: idSchema, state: z.enum(['open', 'dismissed', 'removed']), createdAt: z.iso.datetime() });
export const reportListSchema = z.array(reportSchema).max(50);
export const moderationDecisionSchema = z.strictObject({ action: z.enum(['dismiss', 'remove']) });
export const moderationAccessSchema = z.strictObject({ allowed: z.boolean() });
export const deletionInputSchema = z.strictObject({ password: z.string().min(1).max(128), confirmation: z.literal('DELETE') });
