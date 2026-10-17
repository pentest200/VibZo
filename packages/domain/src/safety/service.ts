import { randomUUID } from 'node:crypto';
import type { ClientSession, Document } from 'mongodb';
import { Long } from 'mongodb';
import { deletionInputSchema, pushSubscriptionSchema, reportInputSchema, reportListSchema } from '@chat/contracts';
import type { DeviceSubscription } from '@chat/contracts';
import { requireModerator } from '../auth/service.js';
import { DomainError, unavailable } from '../auth/errors.js';
import { seal, tokenHash } from '../auth/crypto.js';
import { ConversationStore, denied, conflict } from '../conversations/store.js';
import type { MessageRecord, VisibilityRecord } from '../conversations/model.js';
import { deleteMessageAttachments } from '../attachments/store.js';
import { safetySchemaReady } from './migrations.js';
import type { DeletionJob, DeviceRecord, NotificationPreference, ReportRecord } from './model.js';
import type { SessionRecord } from '../auth/model.js';

// A closed provider allowlist prevents subscriptions from turning the worker into an SSRF proxy.
export function validPushEndpoint(endpoint: string) {
  const url = new URL(endpoint);
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash &&
    (url.hostname === 'fcm.googleapis.com' || url.hostname === 'updates.push.services.mozilla.com' || url.hostname === 'web.push.apple.com');
}
export class SafetyService extends ConversationStore {
  private async ready() { if (!await safetySchemaReady(this.db)) throw unavailable(); }
  async settings(token: string | undefined) {
    await this.ready(); const { user, session } = await this.auth.authenticate(token);
    const preference = await this.db.collection<NotificationPreference>('notificationPreferences').findOne({ _id: user._id });
    const device = await this.db.collection<DeviceRecord>('pushSubscriptions').findOne({ userId: user._id, sessionId: session._id, expiresAt: { $gt: new Date() } });
    return { enabled: preference?.enabled ?? false, subscribed: !!device, available: this.auth.config.PUSH_ENABLED,
      publicKey: this.auth.config.PUSH_ENABLED ? this.auth.config.VAPID_PUBLIC_KEY : '', expiresAt: device?.expiresAt.toISOString() ?? null };
  }
  async preference(token: string | undefined, enabled: boolean) {
    await this.ready();
    await this.run(async session => {
      const { user } = await this.actor(token, session);
      await this.db.collection<NotificationPreference>('notificationPreferences').updateOne({ _id: user._id }, { $set: { enabled }, $setOnInsert: { schemaVersion: 1, createdAt: new Date() } }, { session, upsert: true });
    }); return this.settings(token);
  }
  async subscribe(token: string | undefined, raw: unknown) {
    await this.ready(); if (!this.auth.config.PUSH_ENABLED) throw unavailable();
    const parsed = pushSubscriptionSchema.safeParse(raw);
    if (!parsed.success || !validPushEndpoint(parsed.data.endpoint)) throw new DomainError('INVALID_INPUT', 'Unsupported push subscription.', 400);
    const input: DeviceSubscription = { ...parsed.data, endpoint: new URL(parsed.data.endpoint).href }, now = new Date(), expiresAt = new Date(Math.min(input.expirationTime ?? Infinity, now.getTime() + 30 * 86400000));
    if (expiresAt <= now) throw new DomainError('INVALID_INPUT', 'This push subscription expired.', 400);
    try {
      await this.run(async session => {
        const { user, session: device } = await this.actor(token, session), rows = this.db.collection<DeviceRecord>('pushSubscriptions');
        const existing = await rows.findOne({ endpointHash: tokenHash(input.endpoint) }, { session });
        // Endpoint knowledge is not authority to move a subscription between users or sessions.
        if (existing && (existing.userId !== user._id || existing.sessionId !== device._id)) {
          if (existing.userId !== user._id || await this.db.collection<SessionRecord>('sessions').findOneAndUpdate({ _id: existing.sessionId, userId: user._id, authVersion: user.authVersion, revokedAt: null, expiresAt: { $gt: now } }, { $inc: { guardVersion: 1 } }, { session })) throw conflict('Unsubscribe this browser from its previous session first.');
          await rows.deleteOne({ _id: existing._id }, { session });
        }
        const prior = await rows.findOne({ userId: user._id, sessionId: device._id }, { session });
        if (!prior && await rows.countDocuments({ userId: user._id, expiresAt: { $gt: now } }, { session }) >= this.auth.config.MAX_PUSH_SUBSCRIPTIONS) throw conflict('The notification device limit has been reached.');
        const record: DeviceRecord = { _id: prior?._id ?? randomUUID(), schemaVersion: 1, userId: user._id, sessionId: device._id,
          endpointHash: tokenHash(input.endpoint), encrypted: seal(JSON.stringify(input), this.auth.config.PUSH_ENCRYPTION_KEY), expiresAt, createdAt: now };
        await rows.replaceOne({ _id: record._id }, record, { session, upsert: true });
        await this.db.collection<NotificationPreference>('notificationPreferences').updateOne({ _id: user._id }, { $set: { enabled: true }, $setOnInsert: { schemaVersion: 1, createdAt: now } }, { session, upsert: true });
      });
    } catch (error) { if ((error as { code?: number }).code === 11000) throw conflict('This subscription is already registered.'); throw error; }
    return this.settings(token);
  }
  async unsubscribe(token: string | undefined) {
    await this.ready(); await this.run(async session => {
      const principal = await this.auth.authenticate(token, session);
      await this.db.collection<DeviceRecord>('pushSubscriptions').deleteOne({ userId: principal.user._id, sessionId: principal.session._id }, { session });
    }); return this.settings(token);
  }
  async audit(actorId: string, action: string, targetId: string, session: ClientSession) {
    await this.db.collection<{ _id: string; schemaVersion: 1; actorId: string; action: string; targetId: string; createdAt: Date }>('auditEvents')
      .insertOne({ _id: randomUUID(), schemaVersion: 1, actorId, action, targetId, createdAt: new Date() }, { session });
  }
  async report(token: string | undefined, raw: unknown) {
    await this.ready(); const parsed = reportInputSchema.safeParse(raw); if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Check the report fields.', 400);
    const input = parsed.data, digest = tokenHash(JSON.stringify({ conversationId: input.conversationId, messageId: input.messageId, reason: input.reason })), id = randomUUID();
    return this.run(async session => {
      const ctx = await this.authorize(token, input.conversationId, session), reporterId = ctx.principal.user._id;
      const reports = this.db.collection<ReportRecord>('reports'), previous = await reports.findOne({ reporterId, commandId: input.commandId }, { session });
      if (previous) { if (previous.digest !== digest) throw conflict('This report command was used for different content.'); return { id: previous._id }; }
      if (input.messageId) {
        const message = await this.db.collection<MessageRecord>('messages').findOne({ _id: input.messageId, conversationId: input.conversationId, deletedAt: null }, { session });
        if (!message || !await this.db.collection<VisibilityRecord>('visibilityIntervals').findOne({ conversationId: input.conversationId, userId: reporterId, startSeq: { $lte: message.creationSeq }, $or: [{ endSeq: null }, { endSeq: { $gt: message.creationSeq } }] }, { session })) throw denied();
      }
      if (await reports.countDocuments({ reporterId, createdAt: { $gte: new Date(Date.now() - 86400000) } }, { session, limit: this.auth.config.MAX_REPORTS_PER_DAY }) >= this.auth.config.MAX_REPORTS_PER_DAY) throw new DomainError('RATE_LIMITED', 'Your daily report limit is reached.', 429);
      await reports.insertOne({ _id: id, schemaVersion: 1, reporterId, commandId: input.commandId, digest, conversationId: input.conversationId, messageId: input.messageId, reason: input.reason, state: 'open', createdAt: new Date() }, { session }); return { id };
    });
  }
  async moderationAccess(token: string | undefined) { const p = await this.auth.authenticate(token); return { allowed: !!p.user.verifiedAt && p.user.role === 'moderator' }; }
  async reports(token: string | undefined) {
    await this.ready(); return this.run(async session => {
      const principal = await this.actor(token, session); requireModerator(principal);
      await this.audit(principal.user._id, 'moderation.queue.read', 'reports', session);
      const rows = await this.db.collection<ReportRecord>('reports').find({ state: 'open' }, { session }).sort({ createdAt: 1, _id: 1 }).limit(50).toArray();
      // Moderators see only the reported reference and category, never an arbitrary conversation/body.
      return reportListSchema.parse(rows.map(row => ({ id: row._id, conversationId: row.conversationId, messageId: row.messageId, reason: row.reason, state: row.state, createdAt: row.createdAt.toISOString() })));
    });
  }
  async decide(token: string | undefined, id: string, action: 'dismiss' | 'remove') {
    await this.ready(); await this.run(async session => {
      const principal = await this.actor(token, session); requireModerator(principal);
      const reports = this.db.collection<ReportRecord>('reports'), report = await reports.findOne({ _id: id }, { session }); if (!report) throw denied();
      if (report.state !== 'open') { if (report.state !== (action === 'remove' ? 'removed' : 'dismissed')) throw conflict('This report was already decided.'); return; }
      if (action === 'remove') {
        if (!report.messageId) throw conflict('Only a reported message can be removed.');
        await this.scrubMessage(report.messageId, principal.user._id, session);
      }
      await reports.updateOne({ _id: id, state: 'open' }, { $set: { state: action === 'remove' ? 'removed' : 'dismissed' } }, { session });
      await this.audit(principal.user._id, `moderation.report.${action}`, id, session);
    }); return { accepted: true };
  }
  async scrubMessage(id: string, actorId: string, session: ClientSession) {
    const messages = this.db.collection<MessageRecord>('messages'), row = await messages.findOne({ _id: id }, { session }); if (!row || row.deletedAt) return;
    const conversation = await this.conversations().findOneAndUpdate({ _id: row.conversationId }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' }); if (!conversation) throw denied();
    await messages.updateOne({ _id: id }, { $set: { text: '', deletedAt: new Date(), version: (row.version ?? Long.ZERO).add(Long.ONE) } }, { session });
    await deleteMessageAttachments(this.db, id, session);
    await this.db.collection('messageReactions').deleteMany({ messageId: id }, { session });
    await this.db.collection('syncSnapshots').deleteMany({ conversationId: row.conversationId }, { session });
    await this.event(row.conversationId, actorId, 'message.deleted', { messageId: id }, session);
  }
  async requestDeletion(token: string | undefined, raw: unknown) {
    await this.ready(); const parsed = deletionInputSchema.safeParse(raw); if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Confirm deletion with your password and DELETE.', 400);
    const p = await this.auth.authenticate(token);
    if (!await this.auth.passwords.verify(p.user.passwordHash, parsed.data.password)) throw new DomainError('INVALID_INPUT', 'Current password is incorrect.', 400);
    const deletedIdentity = randomUUID().replaceAll('-', '');
    await this.run(async session => {
      const principal = await this.auth.authenticate(token, session); if (principal.user.passwordHash !== p.user.passwordHash) throw denied();
      const now = new Date(), id = principal.user._id;
      await this.db.collection<Document & { _id: string }>('users').updateOne({ _id: id }, { $set: { deletionState: 'deleting', emailCanonical: `${deletedIdentity}@deleted.invalid`, usernameCanonical: `deleted_${deletedIdentity.slice(0, 16)}`, displayName: 'Deleted account', passwordHash: '', verifiedAt: null, avatarId: null, role: 'user', privacy: { allowSearch: false, showPresence: false }, updatedAt: now }, $inc: { authVersion: 1 } }, { session });
      await this.db.collection('sessions').updateMany({ userId: id }, { $set: { revokedAt: now } }, { session });
      await this.db.collection('pushSubscriptions').deleteMany({ userId: id }, { session });
      await this.db.collection<NotificationPreference>('notificationPreferences').deleteOne({ _id: id }, { session });
      await this.db.collection('authTokens').deleteMany({ userId: id }, { session });
      await this.db.collection('authEmailJobs').updateMany({ userId: id }, { $set: { state: 'dead', encryptedPayload: null, leaseOwner: null, completedAt: now } }, { session });
      await this.db.collection('syncSnapshots').deleteMany({ userId: id }, { session });
      await this.db.collection<DeletionJob>('accountDeletionJobs').insertOne({ _id: id, schemaVersion: 1, state: 'pending', attempts: 0, leaseOwner: null, leaseUntil: new Date(0), availableAt: now, outcome: '', createdAt: now }, { session });
      await this.audit(id, 'account.deletion.request', id, session);
    }); await this.auth.rates.revocationHint(p.user._id); return { accepted: true, message: 'Signed out on all devices. Account deletion is queued and will resume after service interruptions.' };
  }
}
