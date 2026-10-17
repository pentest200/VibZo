import { z } from 'zod';
import { idSchema } from './primitives.js';
export const attachmentKindSchema = z.enum(['jpeg', 'png', 'webp', 'pdf', 'text']);
export const attachmentStateSchema = z.enum(['pending', 'uploaded', 'processing', 'ready', 'rejected', 'deleting', 'deleted']);
export const reserveAttachmentSchema = z.strictObject({ commandId: idSchema, conversationId: idSchema,
  name: z.string().min(1).max(120).refine(value => !Array.from(value).some(char => char.codePointAt(0)! < 32 || char.codePointAt(0) === 127 || '/\\'.includes(char)), 'Use a plain file name.'),
  kind: attachmentKindSchema, size: z.number().int().min(1).max(26214400), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
export const attachmentActionSchema = z.strictObject({ commandId: idSchema });
export const attachmentQuerySchema = z.strictObject({ conversationId: idSchema });
export const attachmentReferenceSchema = z.strictObject({ id: idSchema, name: z.string().max(120), kind: attachmentKindSchema, size: z.number().int().min(1).max(26214400) });
export type AttachmentReference = z.infer<typeof attachmentReferenceSchema>;
export const attachmentSchema = attachmentReferenceSchema.extend({ state: attachmentStateSchema, error: z.string().max(120), expiresAt: z.iso.datetime() });
export type Attachment = z.infer<typeof attachmentSchema>;
export const uploadTicketSchema = z.strictObject({ attachment: attachmentSchema, url: z.url(), headers: z.record(z.string(), z.string()), expiresAt: z.iso.datetime() });
export const attachmentAckSchema = z.strictObject({ attachmentId: idSchema, status: z.literal('accepted') });
export const attachmentListSchema = z.strictObject({ items: z.array(attachmentSchema).max(100) });
export const downloadTicketSchema = z.strictObject({ url: z.url(), expiresAt: z.iso.datetime() });
