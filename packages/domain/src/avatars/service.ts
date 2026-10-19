import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { reserveAvatarSchema, avatarPublishSchema, avatarRemoveSchema, avatarPrivacySchema, avatarDownloadSchema } from '@chat/contracts';
import type { AuthService } from '../auth/service.js';
import type { UserRecord } from '../auth/model.js';
import { tokenHash } from '../auth/crypto.js';
import { DomainError, unavailable } from '../auth/errors.js';
import { conflict, denied } from '../conversations/store.js';
import type { AttachmentRecord, AttachmentQuota } from '../attachments/model.js';
import { attachmentView } from '../attachments/model.js';
import { quota } from '../attachments/store.js';
import { AttachmentService } from '../attachments/service.js';
import { avatarSchemaReady } from './migrations.js';
interface AvatarSettings { _id: string; schemaVersion: 1; visibility: 'self' | 'conversations'; createdAt: Date }
interface AvatarCommand { _id: string; schemaVersion: 1; userId: string; digest: string; avatarId: string | null; createdAt: Date }
const invalid = () => new DomainError('INVALID_INPUT', 'Check the avatar request fields.', 400);
export class AvatarService extends AttachmentService {
  constructor(auth: AuthService) { super(auth, 'avatar'); }
  protected override async ready() { await super.ready(); if (!await avatarSchemaReady(this.db)) throw unavailable(); }
  private settings() { return this.db.collection<AvatarSettings>('avatarSettings'); }
  private async action(userId: string, commandId: string, input: unknown, session: ClientSession) {
    const digest = tokenHash(JSON.stringify(input)), previous = await this.db.collection<AvatarCommand>('avatarCommands').findOne({ _id: `${userId}:${commandId}` }, { session });
    if (previous && previous.digest !== digest) throw conflict('This avatar action ID was used with different content.'); return { digest, previous };
  }
  private async rememberAction(userId: string, commandId: string, digest: string, avatarId: string | null, session: ClientSession) {
    await this.db.collection<AvatarCommand>('avatarCommands').insertOne({ _id: `${userId}:${commandId}`, schemaVersion: 1, userId, digest, avatarId, createdAt: new Date() }, { session });
  }
  override async reserve(token: string | undefined, raw: unknown) {
    await this.ready(); const parsed = reserveAvatarSchema.safeParse(raw); if (!parsed.success) throw invalid();
    const input = parsed.data, config = this.auth.config;
    if (input.size > Math.min(config.MAX_AVATAR_BYTES, config.MAX_ATTACHMENT_BYTES) || !config.ALLOWED_ATTACHMENT_TYPES.includes(input.kind)) throw invalid();
    const id = randomUUID();
    const row = await this.run(async session => {
      const p = await this.actor(token, session), check = await this.action(p.user._id, input.commandId, { action: 'reserve', ...input }, session);
      if (check.previous) { const prior = await this.files().findOne({ _id: check.previous.avatarId!, ownerId: p.user._id, purpose: 'avatar' }, { session }); if (!prior) throw denied(); return prior; }
      const current = await quota(this.db, p.user._id, session), reservedBytes = input.size + Math.min(config.MAX_AVATAR_BYTES, config.MAX_ATTACHMENT_BYTES);
      if (await this.files().countDocuments({ ownerId: p.user._id, purpose: 'avatar', state: { $ne: 'deleted' } }, { session, limit: 10 }) >= 10 || current.bytes + reservedBytes > config.MAX_ACCOUNT_ATTACHMENT_BYTES) throw conflict('Avatar storage limit reached. Remove unused images and allow cleanup to finish.');
      await this.db.collection<AttachmentQuota>('attachmentQuotas').updateOne({ _id: p.user._id }, { $inc: { bytes: reservedBytes } }, { session });
      const now = new Date(), row: AttachmentRecord = { _id: id, schemaVersion: 1, ownerId: p.user._id, conversationId: null, purpose: 'avatar', avatarActive: false,
        name: input.name, kind: input.kind, size: input.size, sha256: input.sha256, state: 'pending', sourceKey: `${this.storage.prefix()}uploads/${id}`, approvedKey: null, approvedSize: 0, approvedType: null, approvedSha256: null,
        sourceCleaned: false, messageId: null, reservedBytes, error: '', createdAt: now, uploadExpiresAt: new Date(now.getTime() + config.UPLOAD_URL_SECONDS * 1000), expiresAt: new Date(now.getTime() + 86400000) };
      await this.files().insertOne(row, { session }); await this.rememberAction(p.user._id, input.commandId, check.digest, id, session); return row;
    });
    if (row.state !== 'pending' || row.uploadExpiresAt <= new Date()) throw conflict('This upload is no longer pending. Refresh your avatars.');
    return { attachment: attachmentView(row), ...await this.storage.upload(row) };
  }
  async profile(token: string | undefined) {
    await this.ready(); return this.run(async session => {
      const p = await this.actor(token, session), settings = await this.settings().findOne({ _id: p.user._id }, { session });
      const rows = await this.files().find({ ownerId: p.user._id, purpose: 'avatar', state: { $ne: 'deleted' } }, { session }).sort({ createdAt: -1 }).limit(10).toArray();
      return { avatarId: p.user.avatarId, visibility: settings?.visibility ?? 'self', items: rows.map(attachmentView) };
    });
  }
  async publish(token: string | undefined, raw: unknown) {
    await this.ready(); const parsed = avatarPublishSchema.safeParse(raw); if (!parsed.success) throw invalid(); const input = parsed.data;
    return this.run(async session => {
      const p = await this.actor(token, session), check = await this.action(p.user._id, input.commandId, { action: 'publish', ...input }, session);
      if (check.previous) return { avatarId: check.previous.avatarId, status: 'accepted' as const };
      if (p.user.avatarId !== input.expectedAvatarId) throw conflict('Your avatar changed on another device. Refresh before replacing it.');
      const row = await this.files().findOne({ _id: input.avatarId, ownerId: p.user._id, purpose: 'avatar', state: 'ready', approvedType: 'image/webp', $or: [{ avatarActive: true }, { expiresAt: { $gt: new Date() } }] }, { session }); if (!row) throw denied();
      if (p.user.avatarId && p.user.avatarId !== row._id) await this.files().updateOne({ _id: p.user.avatarId, ownerId: p.user._id, purpose: 'avatar' }, { $set: { state: 'deleting', avatarActive: false } }, { session });
      await this.files().updateOne({ _id: row._id }, { $set: { avatarActive: true } }, { session });
      await this.db.collection<UserRecord>('users').updateOne({ _id: p.user._id }, { $set: { avatarId: row._id, updatedAt: new Date() } }, { session });
      await this.rememberAction(p.user._id, input.commandId, check.digest, row._id, session); return { avatarId: row._id, status: 'accepted' as const };
    });
  }
  async removeAvatar(token: string | undefined, raw: unknown) {
    await this.ready(); const parsed = avatarRemoveSchema.safeParse(raw); if (!parsed.success) throw invalid(); const input = parsed.data;
    return this.run(async session => {
      const { row, ctx } = await this.own(token, input.avatarId, session), check = await this.action(row.ownerId, input.commandId, { action: 'remove', ...input }, session);
      if (check.previous) return { avatarId: check.previous.avatarId, status: 'accepted' as const };
      if (row.state !== 'deleted') await this.files().updateOne({ _id: row._id }, { $set: { state: 'deleting', avatarActive: false } }, { session });
      const current = ctx.principal.user.avatarId === row._id ? null : ctx.principal.user.avatarId;
      await this.db.collection<UserRecord>('users').updateOne({ _id: row.ownerId }, { $set: { avatarId: current, updatedAt: new Date() } }, { session });
      await this.rememberAction(row.ownerId, input.commandId, check.digest, current, session); return { avatarId: current, status: 'accepted' as const };
    });
  }
  async visibility(token: string | undefined, raw: unknown) {
    await this.ready(); const parsed = avatarPrivacySchema.safeParse(raw); if (!parsed.success) throw invalid(); const input = parsed.data;
    return this.run(async session => {
      const p = await this.actor(token, session), check = await this.action(p.user._id, input.commandId, { action: 'privacy', ...input }, session);
      if (check.previous) return { avatarId: check.previous.avatarId, status: 'accepted' as const };
      await this.settings().updateOne({ _id: p.user._id }, { $set: { visibility: input.visibility }, $setOnInsert: { schemaVersion: 1, createdAt: new Date() } }, { session, upsert: true });
      await this.rememberAction(p.user._id, input.commandId, check.digest, p.user.avatarId, session); return { avatarId: p.user.avatarId, status: 'accepted' as const };
    });
  }
  async downloadAvatar(token: string | undefined, userId: string, raw: unknown) {
    await this.ready(); const parsed = avatarDownloadSchema.safeParse(raw); if (!parsed.success) throw invalid();
    const row = await this.run(async session => {
      const p = await this.actor(token, session);
      const owner = await this.db.collection<UserRecord>('users').findOneAndUpdate({ _id: userId, deletionState: 'active', verifiedAt: { $ne: null } }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' }); if (!owner?.avatarId) throw denied();
      if (p.user._id !== userId) {
        if (!parsed.data.conversationId || !(await this.settings().findOne({ _id: userId, visibility: 'conversations' }, { session }))) throw denied();
        await this.authorize(token, parsed.data.conversationId, session, 'write');
        if (!await this.members().findOneAndUpdate({ conversationId: parsed.data.conversationId, userId, state: 'active' }, { $inc: { guardVersion: 1 } }, { session })) throw denied();
        await this.guardPair(p.user._id, userId, session);
      }
      const row = await this.files().findOne({ _id: owner.avatarId, ownerId: userId, purpose: 'avatar', avatarActive: true, state: 'ready', approvedType: 'image/webp' }, { session }); if (!row) throw denied(); return row;
    });
    try { const head = await this.storage.headApproved(row.approvedKey!); if (head.ContentLength !== row.approvedSize || head.ContentType !== 'image/webp') throw new Error('Missing approved avatar'); } catch { throw unavailable(); }
    return this.storage.avatarDownload(row);
  }
}
