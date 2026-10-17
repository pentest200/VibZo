import { randomUUID } from 'node:crypto';
import { Long } from 'mongodb';
import type { Document } from 'mongodb';
import type { UserRecord } from '../auth/model.js';
import type { MessageRecord, VisibilityRecord, ControlEvent, OutboxRecord, InboxCounter, InboxEvent } from '../conversations/model.js';
import type { ReplayFloor } from '../sync/model.js';
import type { AttachmentRecord } from '../attachments/model.js';
import type { SafetyService } from './service.js';
import type { DeletionJob } from './model.js';
import { safetySchemaReady } from './migrations.js';

export class SafetyMaintenance {
  private conversationCursor: string | undefined;
  private inboxCursor: string | undefined;
  constructor(readonly service: SafetyService, private readonly afterClaim?: () => Promise<void>) {}
  async deletionOnce() {
    const { db } = this.service; if (!await safetySchemaReady(db)) return false;
    const jobs = db.collection<DeletionJob>('accountDeletionJobs');
    await jobs.updateMany({ state: 'claimed', attempts: { $gte: 5 }, $expr: { $lte: ['$leaseUntil', '$$NOW'] } }, { $set: { state: 'failed', outcome: 'LEASE_RETRIES_EXHAUSTED', leaseOwner: null } });
    const job = await jobs.findOneAndUpdate({ attempts: { $lt: 5 }, $or: [{ state: 'pending', $expr: { $lte: ['$availableAt', '$$NOW'] } }, { state: 'claimed', $expr: { $lte: ['$leaseUntil', '$$NOW'] } }] }, [
      { $set: { state: 'claimed', leaseOwner: randomUUID(), attempts: { $add: ['$attempts', 1] }, leaseUntil: { $dateAdd: { startDate: '$$NOW', unit: 'second', amount: 30 } } } }
    ], { sort: { availableAt: 1 }, returnDocument: 'after' }); if (!job) return false;
    await this.afterClaim?.();
    const claim = { _id: job._id, state: 'claimed' as const, leaseOwner: job.leaseOwner, $expr: { $gt: ['$leaseUntil', '$$NOW'] } };
    try {
      await this.service.run(async session => {
        if (!await jobs.findOne(claim, { session })) throw new Error('Deletion lease lost');
        const users = db.collection<UserRecord>('users');
        const user = await users.findOneAndUpdate({ _id: job._id, deletionState: 'deleting' }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' }); if (!user) throw new Error('Deletion account state missing');
        const messages = await db.collection<MessageRecord>('messages').find({ senderId: user._id, deletedAt: null }, { session }).sort({ _id: 1 }).limit(10).toArray();
        for (const message of messages) await this.service.scrubMessage(message._id, user._id, session);
        let more = messages.length > 0;
        if (!more) {
          const member = await this.service.members().findOne({ userId: user._id, state: { $in: ['active', 'invited'] } }, { session, sort: { conversationId: 1 } });
          if (member) {
            more = true;
            const c = await this.service.conversations().findOneAndUpdate({ _id: member.conversationId }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' }); if (!c) throw new Error('Deletion conversation missing');
            if (member.role === 'owner' && c.kind === 'group') {
              const candidates = await this.service.members().find({ conversationId: c._id, state: 'active', userId: { $ne: user._id } }, { session }).sort({ createdAt: 1, userId: 1 }).limit(50).toArray();
              let transferred = false;
              for (const candidate of candidates) {
                if (!await users.findOneAndUpdate({ _id: candidate.userId, deletionState: 'active' }, { $inc: { guardVersion: 1 } }, { session })) continue;
                await this.service.members().updateOne({ _id: candidate._id }, { $set: { role: 'owner', updatedAt: new Date() }, $inc: { guardVersion: 1 } }, { session });
                await this.service.event(c._id, user._id, 'owner.transferred', { targetUserId: candidate.userId }, session); transferred = true; break;
              }
              if (!transferred) {
                await this.service.conversations().updateOne({ _id: c._id }, { $set: { state: 'archived' } }, { session });
                const invited = await this.service.members().find({ conversationId: c._id, state: 'invited' }, { session }).limit(50).toArray();
                await this.service.members().updateMany({ conversationId: c._id, state: 'invited' }, { $set: { state: 'removed', invitationExpiresAt: null, updatedAt: new Date() }, $inc: { guardVersion: 1 } }, { session });
                await this.service.notify(invited.map(m => m.userId), c._id, session);
              }
            }
            await this.service.members().updateOne({ _id: member._id }, { $set: { state: 'left', invitationExpiresAt: null, updatedAt: new Date() }, $inc: { guardVersion: 1 } }, { session });
            const seq = await this.service.event(c._id, user._id, 'member.left', { targetUserId: user._id }, session, [user._id]);
            await db.collection<VisibilityRecord>('visibilityIntervals').updateMany({ conversationId: c._id, userId: user._id, endSeq: null }, { $set: { endSeq: seq } }, { session });
            await db.collection('syncSnapshots').deleteMany({ conversationId: c._id }, { session });
          }
        }
        if (!more) {
          // Idempotent physical removal/quota settlement belongs to the existing attachment worker.
          // A still-valid upload URL can recreate source bytes; wait for its bounded expiry first.
          const files = db.collection<AttachmentRecord>('attachments');
          const batch = await files.find({ ownerId: user._id, state: { $nin: ['deleting', 'deleted'] } }, { session }).limit(20).toArray();
          if (batch.length) await files.updateMany({ _id: { $in: batch.map(f => f._id) } }, { $set: { state: 'deleting', error: 'Account deleted.' } }, { session });
          more = !!await files.findOne({ ownerId: user._id, state: { $ne: 'deleted' } }, { session });
          // These collections contain only the deleting user's projections, credentials and intents.
          for (const name of ['sessions', 'authTokens', 'authEmailJobs', 'pushSubscriptions', 'pushJobs', 'syncSnapshots', 'conversationReceipts', 'messageReactions']) {
            const rows = db.collection<Document & { _id: string }>(name), batch = await rows.find({ userId: user._id }, { session }).limit(100).toArray();
            if (batch.length) { await rows.deleteMany({ _id: { $in: batch.map(row => row._id) } }, { session }); more = true; }
          }
          // Invalidate all inbox snapshots (including peer display names); tickets are ephemeral.
          await db.collection('syncSnapshots').deleteMany({ kind: 'inbox' }, { session });
        }
        if (!more) {
          await db.collection<AttachmentRecord>('attachments').updateMany({ ownerId: user._id, state: 'deleted' }, { $set: { name: 'Deleted file', sha256: '', approvedSha256: null } }, { session });
          await users.updateOne({ _id: user._id }, { $set: { deletionState: 'deleted', updatedAt: new Date() } }, { session });
          await this.service.audit(user._id, 'account.deletion.complete', user._id, session);
        }
        const updated = await jobs.updateOne(claim, { $set: { state: more ? 'pending' : 'done', attempts: 0, leaseOwner: null, leaseUntil: new Date(0), availableAt: new Date(Date.now() + (more ? 1000 : 0)), outcome: more ? 'CLEANUP_PENDING' : 'CLEANUP_COMPLETE' } }, { session });
        if (!updated.matchedCount) throw new Error('Deletion lease lost');
      });
    } catch {
      await jobs.updateOne(claim, { $set: { state: job.attempts >= 5 ? 'failed' : 'pending', outcome: 'CLEANUP_UNAVAILABLE', leaseOwner: null, availableAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** job.attempts)) } });
    } return true;
  }
  async retentionOnce() {
    const { db, auth } = this.service; if (!await safetySchemaReady(db) || !auth.config.CONTENT_RETENTION_DAYS) return false;
    const row = await db.collection<MessageRecord>('messages').findOne({ deletedAt: null, createdAt: { $lt: new Date(Date.now() - auth.config.CONTENT_RETENTION_DAYS * 86400000) } }, { sort: { createdAt: 1 } }); if (!row) return false;
    await this.service.run(session => this.service.scrubMessage(row._id, 'retention', session)); return true;
  }
  async eventRetentionOnce() {
    const { db, auth } = this.service; if (!await safetySchemaReady(db)) return false;
    const c = await this.service.conversations().findOne(this.conversationCursor ? { _id: { $gt: this.conversationCursor } } : {}, { sort: { _id: 1 } });
    if (!c) { this.conversationCursor = undefined; return false; } this.conversationCursor = c._id;
    return this.service.run(async session => {
      await this.service.conversations().updateOne({ _id: c._id }, { $inc: { guardVersion: 1 } }, { session });
      const floors = db.collection<ReplayFloor>('replayFloors'), events = db.collection<ControlEvent>('conversationEvents');
      const floor = await floors.findOne({ _id: c._id }, { session });
      const rows = await events.find({ conversationId: c._id, sequence: { $gt: floor?.floor ?? Long.ZERO } }, { session }).sort({ sequence: 1 }).limit(100).toArray();
      let next = floor?.floor ?? Long.ZERO;
      for (const row of rows) { if (row.createdAt.getTime() >= Date.now() - auth.config.EVENT_RETENTION_DAYS * 86400000) break; next = row.sequence; }
      if (next.greaterThan(floor?.floor ?? Long.ZERO)) {
        await floors.updateOne({ _id: c._id }, { $set: { floor: next }, $setOnInsert: { schemaVersion: 1, createdAt: new Date() } }, { session, upsert: true });
        await db.collection('syncSnapshots').deleteMany({ conversationId: c._id }, { session });
      }
      // Retain canonical references through the entire DLQ/effect/outbox replay horizon.
      const cutoff = new Date(Date.now() - Math.max(auth.config.EFFECT_RETENTION_DAYS, auth.config.COMPLETED_OUTBOX_RETENTION_DAYS, auth.config.EVENT_RETENTION_DAYS) * 86400000);
      const expired = await events.find({ conversationId: c._id, sequence: { $lte: next }, createdAt: { $lt: cutoff } }, { session }).sort({ sequence: 1 }).limit(100).toArray();
      for (const row of expired) {
        const outbox = await db.collection<OutboxRecord>('outbox').findOne({ _id: row._id }, { session });
        if (!outbox || outbox.status !== 'published' || !outbox.publishedAt || outbox.publishedAt >= cutoff) continue;
        if (await db.collection('fanoutJobs').findOne({ eventId: row._id, state: { $ne: 'published' } }, { session }) || await db.collection('notificationJobs').findOne({ eventId: row._id, state: { $ne: 'published' } }, { session }) || await db.collection('pushJobs').findOne({ eventId: row._id, state: { $in: ['pending', 'claimed'] } }, { session })) continue;
        if (await db.collection('consumerEffects').findOne({ eventId: row._id, createdAt: { $gte: cutoff } }, { session })) continue;
        for (const name of ['outbox', 'fanoutJobs', 'notificationJobs', 'pushJobs', 'consumerEffects']) await db.collection(name).deleteMany({ eventId: row._id }, { session });
        await events.deleteOne({ _id: row._id }, { session });
      }
      return true;
    });
  }
  async inboxRetentionOnce() {
    const { db, auth } = this.service; if (!await safetySchemaReady(db)) return false;
    const counter = await db.collection<InboxCounter>('inboxCounters').findOne(this.inboxCursor ? { _id: { $gt: this.inboxCursor } } : {}, { sort: { _id: 1 } });
    if (!counter) { this.inboxCursor = undefined; return false; } this.inboxCursor = counter._id;
    return this.service.run(async session => {
      await this.service.inboxCounter(counter._id, session);
      const floors = db.collection<ReplayFloor>('replayFloors'), key = `inbox:${counter._id}`, floor = await floors.findOne({ _id: key }, { session });
      const events = db.collection<InboxEvent>('inboxEvents'), rows = await events.find({ userId: counter._id, sequence: { $gt: floor?.floor ?? Long.ZERO } }, { session }).sort({ sequence: 1 }).limit(100).toArray();
      let next = floor?.floor ?? Long.ZERO;
      for (const row of rows) { if (row.createdAt.getTime() >= Date.now() - auth.config.EVENT_RETENTION_DAYS * 86400000) break; next = row.sequence; }
      if (next.greaterThan(floor?.floor ?? Long.ZERO)) {
        await floors.updateOne({ _id: key }, { $set: { floor: next }, $setOnInsert: { schemaVersion: 1, createdAt: new Date() } }, { session, upsert: true });
        await events.deleteMany({ userId: counter._id, sequence: { $lte: next } }, { session });
        await db.collection('syncSnapshots').deleteMany({ userId: counter._id, kind: 'inbox' }, { session });
      } return true;
    });
  }
}
