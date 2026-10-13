import { z } from 'zod';
export const emailSchema = z.email().max(254).transform(value => value.toLowerCase());
export const usernameSchema = z.string().min(3).max(24).regex(/^[a-zA-Z][a-zA-Z0-9_]*$/).transform(value => value.toLowerCase());
export const passwordSchema = z.string().min(12).max(128);
export const displayNameSchema = z.string().trim().min(1).max(60);
export const privacySchema = z.strictObject({ showPresence: z.boolean(), allowSearch: z.boolean() });
export const registerSchema = z.strictObject({ email: emailSchema, username: usernameSchema, displayName: displayNameSchema, password: passwordSchema });
export const loginSchema = z.strictObject({ email: emailSchema, password: z.string().min(1).max(128), deviceLabel: z.string().trim().min(1).max(60).default('Web browser') });
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const consumeTokenSchema = z.strictObject({ token: tokenSchema });
export const resetRequestSchema = z.strictObject({ email: emailSchema });
export const resetConfirmSchema = z.strictObject({ token: tokenSchema, password: passwordSchema });
export const passwordChangeSchema = z.strictObject({ currentPassword: z.string().min(1).max(128), password: passwordSchema });
export const profileUpdateSchema = z.strictObject({ username: usernameSchema, displayName: displayNameSchema, privacy: privacySchema });
export const profileSchema = z.strictObject({
  id: z.uuid(), email: emailSchema, username: usernameSchema, displayName: displayNameSchema,
  verified: z.boolean(), privacy: privacySchema, avatarId: z.uuid().nullable()
});
export const authSessionSchema = z.strictObject({ user: profileSchema, csrfToken: tokenSchema, sessionId: z.uuid() });
export const sessionListSchema = z.array(z.strictObject({
  id: z.uuid(), deviceLabel: z.string(), createdAt: z.iso.datetime(), expiresAt: z.iso.datetime(), current: z.boolean()
})).max(10);
export const genericAuthResponseSchema = z.strictObject({ message: z.string() });
export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type ProfileInput = z.infer<typeof profileUpdateSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type AuthSession = z.infer<typeof authSessionSchema>;
