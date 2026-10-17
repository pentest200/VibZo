import { randomUUID } from 'node:crypto';
import webpush from 'web-push';
import type { Config } from '@chat/config';
import type { DeviceSubscription } from '@chat/contracts';
import type { ClientSession } from 'mongodb';
import type { UserRecord, SessionRecord } from '../auth/model.js';
import { unseal, tokenHash } from '../auth/crypto.js';
import type { ControlEvent, MessageRecord, VisibilityRecord } from '../conversations/model.js';
import type { Admission, ProjectionJob } from '../messaging/model.js';
import { safetySchemaReady } from './migrations.js';
import type { DeviceRecord, NotificationPreference, PushJob } from './model.js';
import type { SafetyService } from './service.js';
import { validPushEndpoint } from './service.js';

export const GENERIC_PUSH_PAYLOAD = JSON.stringify({ v: 1, kind: 'inbox' });
export interface PushProvider { send(subscription: DeviceSubscription, topic: string): Promise<void> }
export function webPushProvider(config: Config): PushProvider {
  return { async send(subscription, topic) {
    if (!config.PUSH_ENABLED || !validPushEndpoint(subscription.endpoint)) throw new Error('Push unavailable');
    await webpush.sendNotification({ endpoint: subscription.endpoint, keys: subscription.keys }, GENERIC_PUSH_PAYLOAD, { TTL: 300, timeout: 5000, topic,
      vapidDetails: { subject: config.VAPID_SUBJECT, publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY } });
  } };
}
export class NotificationWorker {
  constructor(readonly service: SafetyService, readonly provider = webPushProvider(service.auth.config)) {}
  private async eligible(userId: string, event: ControlEvent, session: ClientSession) {
    const { db } = this.service;
    if (event.kind !== 'message.created' || !event.payload['messageId'] || event.actorId === userId || event.createdAt.getTime() < Date.now() - 300000) return false;
    const user = await db.collection<UserRecord>('users').findOneAndUpdate({ _id: userId, deletionState: 'active', verifiedAt: { $ne: null } }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' });
    const sender = await db.collection<UserRecord>('users').findOneAndUpdate({ _id: event.actorId, deletionState: 'active' }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' });
    if (!user || !sender || !await db.collection<NotificationPreference>('notificationPreferences').findOne({ _id: userId, enabled: true }, { session })) return false;
    if (!await this.service.conversations().findOneAndUpdate({ _id: event.conversationId, state: 'active' }, { $inc: { guardVersion: 1 } }, { session })) return false;
    if (!await this.service.members().findOneAndUpdate({ conversationId: event.conversationId, userId, state: 'active' }, { $inc: { guardVersion: 1 } }, { session })) return false;
    if (!await this.service.members().findOne({ conversationId: event.conversationId, userId: event.actorId, state: 'active' }, { session })) return false;
    const pair = await this.service.guardPair(userId, event.actorId, session, true); if (pair.blockedBy.length) return false;
    return !!await db.collection<VisibilityRecord>('visibilityIntervals').findOne({ conversationId: event.conversationId, userId, startSeq: { $lte: event.sequence }, $or: [{ endSeq: null }, { endSeq: { $gt: event.sequence } }] }, { session }) &&
      !!await db.collection<MessageRecord>('messages').findOne({ _id: event.payload['messageId'], deletedAt: null }, { session });
  }
  async expandOnce() {
    if (!await safetySchemaReady(this.service.db)) return false;
    return this.service.run(async session => {
      const { db } = this.service, rows = db.collection<ProjectionJob>('notificationJobs');
      await db.collection<Admission>('outboxAdmission').updateOne({ _id: 'projection:notification' }, { $inc: { guardVersion: 1 } }, { session });
      const row = await rows.findOne({ state: 'pending' }, { session, sort: { createdAt: 1 } }); if (!row) return false;
      const event = await db.collection<ControlEvent>('conversationEvents').findOne({ _id: row.eventId }, { session });
      if (this.service.auth.config.PUSH_ENABLED && event && event.createdAt.getTime() >= Date.now() - 300000) {
        const members = await this.service.members().find({ conversationId: event.conversationId, state: 'active' }, { session }).sort({ userId: 1 }).limit(50).toArray();
        const jobs = db.collection<PushJob>('pushJobs');
        let pending = await jobs.countDocuments({ state: { $in: ['pending', 'claimed'] } }, { session, limit: this.service.auth.config.MAX_PENDING_PUSH_JOBS });
        for (const member of members) {
          if (!await this.eligible(member.userId, event, session)) continue;
          const devices = await db.collection<DeviceRecord>('pushSubscriptions').find({ userId: member.userId, expiresAt: { $gt: new Date() } }, { session }).limit(10).toArray();
          for (const device of devices) {
            if (++pending > this.service.auth.config.MAX_PENDING_PUSH_JOBS) throw new Error('Push backlog full');
            const now = new Date(); await jobs.insertOne({ _id: `${event._id}:${device._id}`, schemaVersion: 1, eventId: event._id, conversationId: event.conversationId,
              userId: member.userId, subscriptionId: device._id, state: 'pending', attempts: 0, leaseOwner: null, leaseUntil: new Date(0), availableAt: now,
              expiresAt: new Date(event.createdAt.getTime() + 300000), outcome: '', createdAt: now }, { session });
          }
        }
      }
      await rows.updateOne({ _id: row._id, state: 'pending' }, { $set: { state: 'published' } }, { session }); return true;
    });
  }
  async runOnce() {
    const { db } = this.service; if (!await safetySchemaReady(db)) return false;
    const jobs = db.collection<PushJob>('pushJobs');
    await jobs.updateMany({ state: 'claimed', attempts: { $gte: 5 }, $expr: { $lte: ['$leaseUntil', '$$NOW'] } }, { $set: { state: 'failed', outcome: 'LEASE_RETRIES_EXHAUSTED', leaseOwner: null } });
    const row = await jobs.findOneAndUpdate({ attempts: { $lt: 5 }, $or: [{ state: 'pending', $expr: { $lte: ['$availableAt', '$$NOW'] } }, { state: 'claimed', $expr: { $lte: ['$leaseUntil', '$$NOW'] } }] }, [
      { $set: { state: 'claimed', leaseOwner: randomUUID(), attempts: { $add: ['$attempts', 1] }, leaseUntil: { $dateAdd: { startDate: '$$NOW', unit: 'second', amount: 30 } } } }
    ], { returnDocument: 'after', sort: { availableAt: 1 } }); if (!row) return false;
    const claim = { _id: row._id, state: 'claimed' as const, leaseOwner: row.leaseOwner, $expr: { $gt: ['$leaseUntil', '$$NOW'] } };
    let attempted: DeviceRecord | null = null;
    try {
      const device = await this.service.run(async session => {
        if (!this.service.auth.config.PUSH_ENABLED || row.expiresAt <= new Date() || !await jobs.findOne(claim, { session })) return null;
        const event = await db.collection<ControlEvent>('conversationEvents').findOne({ _id: row.eventId }, { session });
        if (!event || !await this.eligible(row.userId, event, session)) return null;
        const device = await db.collection<DeviceRecord>('pushSubscriptions').findOne({ _id: row.subscriptionId, userId: row.userId, expiresAt: { $gt: new Date() } }, { session }); if (!device) return null;
        const user = await db.collection<UserRecord>('users').findOne({ _id: row.userId }, { session });
        if (!await db.collection<SessionRecord>('sessions').findOneAndUpdate({ _id: device.sessionId, userId: row.userId, authVersion: user!.authVersion, revokedAt: null, expiresAt: { $gt: new Date() } }, { $inc: { guardVersion: 1 } }, { session })) return null;
        return device;
      });
      if (!device) { await jobs.updateOne(claim, { $set: { state: 'skipped', outcome: 'EXPIRED_OR_NO_AUTHORITY', leaseOwner: null } }); return true; }
      attempted = device;
      await this.provider.send(JSON.parse(unseal(device.encrypted, this.service.auth.config.PUSH_ENCRYPTION_KEY)) as DeviceSubscription, tokenHash(`${row.userId}:${device._id}`).slice(0, 32));
      // Provider acceptance is not display/delivery. A crash here can cause a duplicate generic push.
      await jobs.updateOne(claim, { $set: { state: 'sent', outcome: 'PROVIDER_ACCEPTED', leaseOwner: null } });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'statusCode' in error ? Number(error.statusCode) : 0;
      await this.service.run(async session => {
        const gone = code === 404 || code === 410, terminal = gone || code >= 400 && code < 500 && code !== 429 || row.attempts >= 5;
        const changed = await jobs.updateOne(claim, { $set: { state: gone ? 'skipped' : terminal ? 'failed' : 'pending', outcome: gone ? 'SUBSCRIPTION_GONE' : 'PROVIDER_UNAVAILABLE', leaseOwner: null, availableAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** row.attempts)) } }, { session });
        if (gone && changed.matchedCount && attempted) await db.collection<DeviceRecord>('pushSubscriptions').deleteOne({ _id: row.subscriptionId, encrypted: attempted.encrypted }, { session });
      });
    } return true;
  }
}
