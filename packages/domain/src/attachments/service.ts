import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { reserveAttachmentSchema } from '@chat/contracts';
import { ConversationService } from '../conversations/service.js';
import type { AuthService } from '../auth/service.js';
import { DomainError, unavailable } from '../auth/errors.js';
import { tokenHash } from '../auth/crypto.js';
import { conflict, denied } from '../conversations/store.js';
import type { MessageRecord, VisibilityRecord } from '../conversations/model.js';
import type { AttachmentCommand, AttachmentRecord, AttachmentJob, AttachmentQuota } from './model.js';
import { attachmentView, contentTypes } from './model.js';
import { attachmentSchemaReady } from './migrations.js';
import { AttachmentStorage } from './storage.js';
import { quota, scheduleScan } from './store.js';
export class AttachmentService extends ConversationService {
  readonly storage: AttachmentStorage;
  constructor(auth: AuthService) { super(auth); this.storage = new AttachmentStorage(auth.config); }
  files() { return this.db.collection<AttachmentRecord>('attachments'); }
  private async ready() { if (!await attachmentSchemaReady(this.db)) throw unavailable(); }
  private async command(userId: string, id: string, input: unknown, session: ClientSession) {
    const digest = tokenHash(JSON.stringify(input)), previous = await this.db.collection<AttachmentCommand>('attachmentCommands').findOne({ _id: `${userId}:${id}` }, { session });
    if (previous && previous.digest !== digest) throw conflict('This file action ID was used with different content.'); return { digest, previous };
  }
  private async remember(userId: string, commandId: string, digest: string, attachmentId: string, session: ClientSession) { await this.db.collection<AttachmentCommand>('attachmentCommands').insertOne({ _id: `${userId}:${commandId}`, schemaVersion: 1, userId, digest, attachmentId, createdAt: new Date() }, { session }); }
  async reserve(token: string | undefined, raw: unknown) {
    await this.ready(); const parsed = reserveAttachmentSchema.safeParse(raw); if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Check file name, size, type and checksum.', 400);
    const input = parsed.data, config = this.auth.config, id = randomUUID();
    if (input.size > config.MAX_ATTACHMENT_BYTES || !config.ALLOWED_ATTACHMENT_TYPES.includes(input.kind)) throw new DomainError('INVALID_INPUT', 'This file size or type is not allowed.', 400);
    const row = await this.authorizedOperation(token, input.conversationId, async ({ principal, session }) => {
      const userId = principal.user._id, check = await this.command(userId, input.commandId, { action: 'reserve', ...input }, session);
      if (check.previous) { const previous = await this.files().findOne({ _id: check.previous.attachmentId, ownerId: userId }, { session }); if (!previous) throw denied(); return previous; }
      const reservedBytes = input.size + (['jpeg', 'png', 'webp'].includes(input.kind) ? config.MAX_ATTACHMENT_BYTES : input.size), current = await quota(this.db, userId, session);
      const count = await this.files().countDocuments({ ownerId: userId, state: { $ne: 'deleted' }, messageId: null }, { session, limit: 100 });
      if (count >= 100 || current.bytes + reservedBytes > config.MAX_ACCOUNT_ATTACHMENT_BYTES) throw conflict('Your file storage limit is reached. Remove unused files first.');
      await this.db.collection<AttachmentQuota>('attachmentQuotas').updateOne({ _id: userId }, { $inc: { bytes: reservedBytes } }, { session });
      const now = new Date(), row: AttachmentRecord = { _id: id, schemaVersion: 1, ownerId: userId, conversationId: input.conversationId, name: input.name, kind: input.kind, size: input.size, sha256: input.sha256, state: 'pending',
        sourceKey: `${this.storage.prefix()}uploads/${id}`, approvedKey: null, approvedSize: 0, approvedType: null, approvedSha256: null, sourceCleaned: false, messageId: null, reservedBytes, error: '', createdAt: now,
        uploadExpiresAt: new Date(now.getTime() + config.UPLOAD_URL_SECONDS * 1000), expiresAt: new Date(now.getTime() + 86400000) };
      await this.files().insertOne(row, { session }); await this.remember(userId, input.commandId, check.digest, id, session); return row;
    });
    if (row.state !== 'pending' || row.uploadExpiresAt <= new Date()) throw conflict('This upload is no longer pending. Refresh the file list.');
    return { attachment: attachmentView(row), ...await this.storage.upload(row) };
  }
  private async own(token: string | undefined, id: string, session: ClientSession) {
    const row = await this.files().findOne({ _id: id }, { session }); if (!row) throw denied();
    const ctx = await this.authorize(token, row.conversationId, session, 'write'); if (ctx.principal.user._id !== row.ownerId) throw denied(); return { row, ctx };
  }
  async finalize(token: string | undefined, id: string, commandId: string) {
    await this.ready();
    const initial = await this.run(async session => (await this.own(token, id, session)).row);
    if (initial.state === 'pending') {
      let head; try { head = await this.storage.head(initial.sourceKey); } catch { throw unavailable(); }
      if (head.ContentLength !== initial.size || head.Metadata?.['attachment'] !== id || head.Metadata?.['owner'] !== initial.ownerId || head.ContentType !== contentTypes[initial.kind]) throw conflict('The uploaded file does not match its reservation.');
    }
    return this.run(async session => {
      const { row, ctx } = await this.own(token, id, session), check = await this.command(row.ownerId, commandId, { kind: 'finalize', id }, session);
      if (!check.previous) {
        if (row.state === 'pending') {
          if (row.uploadExpiresAt <= new Date()) throw conflict('This upload expired.');
          await quota(this.db, 'global-jobs', session);
          if (await this.db.collection<AttachmentJob>('attachmentJobs').countDocuments({ state: { $in: ['pending', 'claimed', 'failed'] } }, { session, limit: this.auth.config.MAX_PENDING_ATTACHMENT_JOBS }) >= this.auth.config.MAX_PENDING_ATTACHMENT_JOBS) throw unavailable();
          await this.files().updateOne({ _id: id, state: 'pending' }, { $set: { state: 'uploaded' } }, { session }); await scheduleScan(this.db, id, session);
        } else if (!['uploaded', 'processing', 'ready'].includes(row.state)) throw conflict('This file cannot be finalized.');
        await this.remember(ctx.principal.user._id, commandId, check.digest, id, session);
      }
      return { attachmentId: id, status: 'accepted' as const };
    });
  }
  async retry(token: string | undefined, id: string, commandId: string) {
    await this.ready(); return this.run(async session => {
      const { row } = await this.own(token, id, session), check = await this.command(row.ownerId, commandId, { kind: 'retry', id }, session);
      if (!check.previous) {
        if (row.expiresAt <= new Date() || row.state !== 'uploaded') throw conflict('This file cannot be retried.');
        const changed = await this.db.collection<AttachmentJob>('attachmentJobs').updateOne({ _id: id, state: 'failed' }, { $set: { state: 'pending', attempts: 0, availableAt: new Date(), leaseUntil: new Date(0), leaseOwner: null } }, { session });
        if (!changed.matchedCount) throw conflict('This file is already being checked.');
        await this.files().updateOne({ _id: id }, { $set: { error: '' } }, { session }); await this.remember(row.ownerId, commandId, check.digest, id, session);
      } return { attachmentId: id, status: 'accepted' as const };
    });
  }
  async list(token: string | undefined, conversationId: string) {
    await this.ready(); return this.run(async session => {
      const ctx = await this.authorize(token, conversationId, session, 'write');
      const rows = await this.files().find({ conversationId, ownerId: ctx.principal.user._id, messageId: null, state: { $ne: 'deleted' } }, { session }).sort({ createdAt: 1 }).limit(100).toArray(); return { items: rows.map(attachmentView) };
    });
  }
  async removeFile(token: string | undefined, id: string, commandId: string) {
    await this.ready(); return this.run(async session => {
      const { row } = await this.own(token, id, session), check = await this.command(row.ownerId, commandId, { kind: 'delete', id }, session);
      if (!check.previous) {
        if (row.messageId) throw conflict('Delete the message to remove its files.');
        if (row.state !== 'deleted') await this.files().updateOne({ _id: id }, { $set: { state: 'deleting' } }, { session });
        await this.remember(row.ownerId, commandId, check.digest, id, session);
      } return { attachmentId: id, status: 'accepted' as const };
    });
  }
  async download(token: string | undefined, id: string) {
    await this.ready(); const row = await this.run(async session => {
      const row = await this.files().findOne({ _id: id, state: 'ready' }, { session }); if (!row) throw denied();
      const ctx = await this.authorize(token, row.conversationId, session, 'write');
      if (!row.messageId) { if (ctx.principal.user._id !== row.ownerId || row.expiresAt <= new Date()) throw denied(); }
      else {
        const message = await this.db.collection<MessageRecord>('messages').findOne({ _id: row.messageId, conversationId: row.conversationId, deletedAt: null, attachmentIds: id }, { session });
        if (!message || !await this.db.collection<VisibilityRecord>('visibilityIntervals').findOne({ conversationId: row.conversationId, userId: ctx.principal.user._id, startSeq: { $lte: message.creationSeq }, $or: [{ endSeq: null }, { endSeq: { $gt: message.creationSeq } }] }, { session })) throw denied();
      } return row;
    });
    try { const head = await this.storage.headApproved(row.approvedKey!); if (head.ContentLength !== row.approvedSize || head.ContentType !== row.approvedType) throw new Error('Approved object missing or changed'); } catch { throw unavailable(); }
    return this.storage.download(row);
  }
  close() { this.storage.close(); }
}
