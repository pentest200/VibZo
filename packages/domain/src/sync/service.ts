import { messageAttachments, deleteMessageAttachments } from '../attachments/store.js';
import { randomUUID } from 'node:crypto';
import { Long } from 'mongodb';
import type { ClientSession } from 'mongodb';
import { conversationSnapshotSchema, mutationSchema } from '@chat/contracts';
import type { ConversationSnapshot } from '@chat/contracts';
import { MessageService } from '../messaging/service.js';
import { DomainError, unavailable } from '../auth/errors.js';
import { tokenHash } from '../auth/crypto.js';
import type { UserRecord } from '../auth/model.js';
import { conflict, denied } from '../conversations/store.js';
import type { ConversationContext } from '../conversations/store.js';
import type { ControlEvent, MessageRecord, VisibilityRecord } from '../conversations/model.js';
import { longToSequence, sequenceToLong } from '../sequence.js';
import { eventReference } from '../messaging/delivery.js';
import type { MutationCommand, Reaction, Receipt, ReplayFloor, SnapshotRecord } from './model.js';
import { syncSchemaReady } from './migrations.js';
export class SyncService extends MessageService {
  private async ready() { if (!await syncSchemaReady(this.db)) throw unavailable(); }
  private async visible(id: string, userId: string, sequence: Long, session: ClientSession) {
    return !!await this.db.collection<VisibilityRecord>('visibilityIntervals').findOne({ conversationId: id, userId, startSeq: { $lte: sequence }, $or: [{ endSeq: null }, { endSeq: { $gt: sequence } }] }, { session });
  }
  async replay(token: string | undefined, id: string, after: string, through?: string, limit = 100) {
    await this.ready();
    return this.run(async session => {
      const ctx = await this.authorize(token, id, session), watermark = through ? sequenceToLong(through) : ctx.conversation.nextEventSeq, cursor = sequenceToLong(after);
      const floor = await this.db.collection<ReplayFloor>('replayFloors').findOne({ _id: id }, { session });
      if (floor && cursor.lessThan(floor.floor)) throw new DomainError('CURSOR_EXPIRED', 'Refresh the conversation snapshot to continue.', 409);
      if (cursor.greaterThan(watermark) || watermark.greaterThan(ctx.conversation.nextEventSeq)) throw new DomainError('INVALID_INPUT', 'Invalid replay cursor.', 400);
      // Limit scanned rows first. Hidden positions still advance nextCursor without exposing their references.
      const rows = await this.db.collection<ControlEvent>('conversationEvents').find({ conversationId: id, sequence: { $gt: cursor, $lte: watermark } }, { session }).sort({ sequence: 1 }).limit(Math.min(100, limit) + 1).toArray();
      const page = rows.slice(0, limit), events = [];
      for (const row of page) if (await this.visible(id, ctx.principal.user._id, row.sequence, session)) events.push(eventReference(row));
      return { events, nextCursor: rows.length > limit ? longToSequence(page.at(-1)!.sequence) : longToSequence(watermark), watermark: longToSequence(watermark), hasMore: rows.length > limit };
    });
  }
  private async window(ctx: ConversationContext, before?: string): Promise<ConversationSnapshot> {
    const { session, conversation: c, principal } = ctx;
    const rows = await this.db.collection<MessageRecord>('messages').aggregate<MessageRecord>([
      { $match: { conversationId: c._id, ...(before ? { creationSeq: { $lt: sequenceToLong(before) } } : {}) } }, { $sort: { creationSeq: -1 } },
      { $lookup: { from: 'visibilityIntervals', let: { seq: '$creationSeq' }, pipeline: [{ $match: { conversationId: c._id, userId: principal.user._id, $expr: { $and: [{ $lte: ['$startSeq', '$$seq'] }, { $or: [{ $eq: ['$endSeq', null] }, { $gt: ['$endSeq', '$$seq'] }] }] } } }, { $limit: 1 }], as: '_visible' } },
      { $match: { '_visible.0': { $exists: true } } }, { $limit: 101 }, { $project: { _visible: 0 } }
    ], { session, maxTimeMS: 3000 }).toArray();
    const page = rows.slice(0, 100), active = await this.members().find({ conversationId: c._id, state: 'active' }, { session }).limit(50).toArray(), activeIds = active.map(member => member.userId);
    const reactions = await this.db.collection<Reaction>('messageReactions').aggregate<{ _id: { messageId: string; reaction: string }; count: number; mine: number }>([
      { $match: { conversationId: c._id, messageId: { $in: page.map(row => row._id) }, userId: { $in: activeIds } } },
      { $group: { _id: { messageId: '$messageId', reaction: '$reaction' }, count: { $sum: 1 }, mine: { $max: { $cond: [{ $eq: ['$userId', principal.user._id] }, 1, 0] } } } }
    ], { session, maxTimeMS: 3000 }).toArray();
    const receipts = await this.db.collection<Receipt>('conversationReceipts').find({ conversationId: c._id, userId: { $in: activeIds } }, { session }).limit(50).toArray();
    const windows = await this.db.collection<VisibilityRecord>('visibilityIntervals').find({ conversationId: c._id, userId: { $in: activeIds }, endSeq: null }, { session }).limit(50).toArray();
    const attachments = await messageAttachments(this.db, page, session);
    return conversationSnapshotSchema.parse({ conversationId: c._id, watermark: longToSequence(c.nextEventSeq), capturedAt: new Date().toISOString(), olderBefore: rows.length > 100 ? longToSequence(page.at(-1)!.creationSeq) : null,
      messages: page.map(row => ({ id: row._id, senderId: row.senderId, clientMessageId: row.clientMessageId, creationSequence: longToSequence(row.creationSeq), version: longToSequence(row.version ?? Long.ZERO),
        attachments: attachments.get(row._id) ?? [], text: row.deletedAt ? '' : row.text, replyToId: row.replyToId ?? null, deleted: !!row.deletedAt, createdAt: row.createdAt.toISOString(), reactions: row.deletedAt ? [] : reactions.filter(item => item._id.messageId === row._id).map(item => ({ reaction: item._id.reaction, count: item.count, mine: !!item.mine })) })),
      receipts: receipts.flatMap(row => { const window = windows.find(window => window.userId === row.userId); return window ? [{ userId: row.userId, delivered: longToSequence(row.delivered), deliveredFrom: longToSequence(row.deliveredFrom), read: longToSequence(row.read), visibleFrom: longToSequence(window.startSeq) }] : []; }) });
  }
  async snapshot(token: string | undefined, id: string, before?: string) { await this.ready(); return this.run(async session => this.window(await this.authorize(token, id, session), before)); }
  async createSnapshot(token: string | undefined, kind: 'inbox' | 'conversation', conversationId?: string) {
    await this.ready(); const snapshotId = randomUUID();
    // Capture all inbox rows and watermark in a single guarded transaction. Array is product-bounded.
    return this.run(async session => {
      const principal = await this.actor(token, session), now = new Date(), expiresAt = new Date(now.getTime() + 120000);
      await this.inboxCounter(principal.user._id, session);
      if (await this.db.collection<SnapshotRecord>('syncSnapshots').countDocuments({ userId: principal.user._id, expiresAt: { $gt: now } }, { session, limit: 4 }) >= 4) throw new DomainError('RATE_LIMITED', 'Too many active snapshots. Try again shortly.', 429, true);
      let payload: SnapshotRecord['payload'], watermark: string;
      if (kind === 'conversation') {
        if (!conversationId) throw denied(); payload = await this.window(await this.authorize(token, conversationId, session)); watermark = payload.watermark;
      } else {
        const members = await this.members().find({ userId: principal.user._id, $or: [{ state: 'active' }, { state: 'invited', invitationExpiresAt: { $gt: now } }] }, { session }).sort({ conversationId: 1 }).limit(this.auth.config.MAX_CONVERSATIONS_PER_USER + 1).toArray();
        if (members.length > this.auth.config.MAX_CONVERSATIONS_PER_USER) throw unavailable();
        const conversations = await this.conversations().find({ _id: { $in: members.map(row => row.conversationId) }, state: 'active' }, { session }).toArray(), byId = new Map(conversations.map(c => [c._id, c]));
        const peers = conversations.flatMap(c => c.directPair?.split(':').filter(userId => userId !== principal.user._id) ?? []);
        const users = await this.db.collection<UserRecord>('users').find({ _id: { $in: peers } }, { session }).toArray(), names = new Map(users.map(user => [user._id, user.displayName]));
        const counts = await this.db.collection<MessageRecord>('messages').aggregate<{ _id: string; count: number }>([
          { $match: { conversationId: { $in: conversations.map(c => c._id) }, senderId: { $ne: principal.user._id }, deletedAt: null } },
          { $lookup: { from: 'conversationReceipts', let: { conv: '$conversationId' }, pipeline: [{ $match: { userId: principal.user._id, $expr: { $eq: ['$conversationId', '$$conv'] } } }, { $limit: 1 }], as: '_receipt' } },
          { $match: { $expr: { $gt: ['$creationSeq', { $ifNull: [{ $arrayElemAt: ['$_receipt.read', 0] }, Long.ZERO] }] } } },
          { $lookup: { from: 'visibilityIntervals', let: { conv: '$conversationId', seq: '$creationSeq' }, pipeline: [{ $match: { userId: principal.user._id, $expr: { $and: [{ $eq: ['$conversationId', '$$conv'] }, { $lte: ['$startSeq', '$$seq'] }, { $or: [{ $eq: ['$endSeq', null] }, { $gt: ['$endSeq', '$$seq'] }] }] } } }, { $limit: 1 }], as: '_visible' } },
          { $match: { '_visible.0': { $exists: true } } }, { $group: { _id: '$conversationId', count: { $sum: 1 } } }
        ], { session, maxTimeMS: 3000 }).toArray(); const unread = new Map(counts.map(row => [row._id, Math.min(1000, row.count)]));
        payload = members.flatMap(member => { const c = byId.get(member.conversationId); if (!c) return []; const otherUserId = c.directPair?.split(':').find(userId => userId !== principal.user._id) ?? null;
          return [{ id: c._id, kind: c.kind, title: otherUserId ? names.get(otherUserId) ?? 'Unavailable account' : c.title, role: member.role, state: member.state, otherUserId, unread: unread.get(c._id) ?? 0, updatedAt: c.updatedAt.toISOString() }]; });
        watermark = longToSequence((await this.inboxCounter(principal.user._id, session)).sequence);
      }
      await this.db.collection<SnapshotRecord>('syncSnapshots').insertOne({ _id: snapshotId, schemaVersion: 1, userId: principal.user._id, kind, conversationId: conversationId ?? null, watermark, payload, expiresAt, createdAt: now }, { session });
      return { id: snapshotId, watermark, expiresAt: expiresAt.toISOString() };
    });
  }
  async snapshotPage(token: string | undefined, id: string, page: number) {
    return this.run(async session => {
      const principal = await this.actor(token, session), row = await this.db.collection<SnapshotRecord>('syncSnapshots').findOne({ _id: id, userId: principal.user._id }, { session });
      if (!row) throw denied(); if (row.expiresAt <= new Date()) throw new DomainError('CURSOR_EXPIRED', 'This snapshot expired. Capture another snapshot.', 409);
      if (row.conversationId) await this.authorize(token, row.conversationId, session);
      if (row.kind === 'conversation') { if (page) throw denied(); return { kind: row.kind, watermark: row.watermark, data: row.payload, nextPage: null }; }
      const items = row.payload as unknown[], start = page * 100; if (start > items.length) throw denied();
      return { kind: row.kind, watermark: row.watermark, data: items.slice(start, start + 100), nextPage: start + 100 < items.length ? page + 1 : null };
    });
  }
  async mutate(token: string | undefined, raw: unknown) {
    await this.ready(); const result = mutationSchema.safeParse(raw); if (!result.success) throw new DomainError('INVALID_INPUT', 'Check the message action fields.', 400);
    const input = result.data, digest = tokenHash(JSON.stringify(input)), eventId = randomUUID();
    return this.authorizedOperation(token, input.conversationId, async ctx => {
      const { session, principal, conversation } = ctx, userId = principal.user._id, commands = this.db.collection<MutationCommand>('mutationCommands');
      const key = `${userId}:${input.commandId}`, previous = await commands.findOne({ _id: key }, { session });
      if (previous) { if (previous.digest !== digest) throw conflict('This action ID was used with different content.'); return { status: 'accepted' as const, sequence: longToSequence(previous.sequence) }; }
      let sequence = conversation.nextEventSeq;
      if (input.kind === 'receipt') {
        const delivered = sequenceToLong(input.delivered), read = sequenceToLong(input.read), from = sequenceToLong(input.appliedFrom);
        if (from.greaterThan(delivered) || read.greaterThan(delivered) || delivered.greaterThan(conversation.nextEventSeq)) throw new DomainError('INVALID_INPUT', 'Invalid receipt position.', 400);
        const receipts = this.db.collection<Receipt>('conversationReceipts'), id = `${conversation._id}:${userId}`, old = await receipts.findOne({ _id: id }, { session });
        // Account-level aggregate: merge overlapping applied windows; disjoint newer windows replace the delivery range.
        let deliveredFrom = from;
        if (old) {
          if (from.lessThanOrEqual(old.delivered) && delivered.greaterThanOrEqual(old.deliveredFrom)) deliveredFrom = from.lessThan(old.deliveredFrom) ? from : old.deliveredFrom;
          else if (delivered.lessThanOrEqual(old.delivered)) deliveredFrom = old.deliveredFrom;
        }
        if (!old || delivered.greaterThan(old.delivered) || read.greaterThan(old.read) || !deliveredFrom.equals(old.deliveredFrom)) {
          await receipts.updateOne({ _id: id }, { $setOnInsert: { schemaVersion: 1, conversationId: conversation._id, userId, createdAt: new Date() }, $set: { deliveredFrom }, $max: { delivered, read } }, { upsert: true, session });
          sequence = await this.event(conversation._id, userId, 'receipt.changed', { userId }, session, [], eventId);
        }
      } else {
        const messages = this.db.collection<MessageRecord>('messages'), message = await messages.findOne({ _id: input.messageId, conversationId: conversation._id }, { session });
        if (!message || !await this.visible(conversation._id, userId, message.creationSeq, session)) throw denied();
        if (input.kind === 'reaction') {
          if (message.deletedAt) throw denied();
          const reactions = this.db.collection<Reaction>('messageReactions'), id = `${message._id}:${userId}:${input.reaction}`, old = await reactions.findOne({ _id: id }, { session });
          if (!!old !== input.active) {
            if (input.active) await reactions.insertOne({ _id: id, schemaVersion: 1, conversationId: conversation._id, messageId: message._id, userId, reaction: input.reaction, createdAt: new Date() }, { session }); else await reactions.deleteOne({ _id: id }, { session });
            sequence = await this.event(conversation._id, userId, 'reaction.changed', { messageId: message._id }, session, [], eventId);
          }
        } else {
          if (message.senderId !== userId || message.deletedAt) throw denied();
          const version = message.version ?? Long.ZERO; if (!version.equals(sequenceToLong(input.expectedVersion))) throw conflict('This message changed. Refresh before editing again.');
          if (version.equals(Long.MAX_VALUE)) throw conflict('Message version exhausted.');
          const text = input.kind === 'edit' ? input.text.replace(/\r\n?/g, '\n').normalize('NFC') : '';
          if (input.kind === 'edit' && (!text.trim() || Array.from(text).length > this.auth.config.MAX_MESSAGE_CODEPOINTS)) throw new DomainError('INVALID_INPUT', 'Check the edited message length.', 400);
          await messages.updateOne({ _id: message._id }, { $set: { text, version: version.add(Long.ONE), ...(input.kind === 'delete' ? { deletedAt: new Date() } : {}) } }, { session });
          if (input.kind === 'delete') await deleteMessageAttachments(this.db, message._id, session);
          sequence = await this.event(conversation._id, userId, input.kind === 'edit' ? 'message.edited' : 'message.deleted', { messageId: message._id }, session, [], eventId);
        }
      }
      await commands.insertOne({ _id: key, schemaVersion: 1, userId, commandId: input.commandId, digest, sequence, createdAt: new Date() }, { session });
      return { status: 'accepted' as const, sequence: longToSequence(sequence) };
    });
  }
}
