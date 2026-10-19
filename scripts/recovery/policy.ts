import { randomUUID } from 'node:crypto';
import type { Long } from 'mongodb';
import type { Db, Document, MongoClient } from 'mongodb';
import type { Config } from '@chat/config';
import { AuthService, SafetyService } from '@chat/domain';
import type { AttachmentRecord, UserRecord, MembershipRecord, VisibilityRecord, ConversationRecord, ControlEvent } from '@chat/domain';
import { inspectBundle, RecoveryError } from './bundle.js';
import { parse } from './runtime.js';
import { policyCollections } from './capture.js';

export type Policy = Record<typeof policyCollections[number], Document[]>;
export async function loadPolicy(path: string, key: Buffer) {
  const result: Partial<Policy> = {}; let name = '', parts: Buffer[] = [], total = 0;
  const manifest = await inspectBundle(path, key, {
    async begin(entry) { if (!policyCollections.includes(entry as keyof Policy)) throw new RecoveryError('Unexpected policy entry'); name = entry; parts = []; },
    async data(bytes) { total += bytes.length; if (total > 64 * 1048576) throw new RecoveryError('Policy byte budget'); parts.push(bytes); },
    async end() { const rows = parse<Document[]>(Buffer.concat(parts).toString('utf8')); if (!Array.isArray(rows) || rows.length > 5000 || rows.some(row => !row || typeof row['_id'] !== 'string')) throw new RecoveryError('Invalid policy records'); result[name as keyof Policy] = rows; }
  });
  if (manifest.kind !== 'policy' || policyCollections.some(name => !result[name])) throw new RecoveryError('Incomplete policy');
  return { manifest, policy: result as Policy };
}
export async function sanitize(client: MongoClient, db: Db, config: Config, policy: Policy) {
  const now = new Date(), users = db.collection<UserRecord>('users'), current = new Map(policy.users.map(row => [String(row['_id']), row as UserRecord]));
  const deleted = new Set<string>();
  for await (const user of users.find()) {
    const latest = current.get(user._id); if (!latest) throw new RecoveryError('Current account authority is missing');
    const state = latest.deletionState === 'active' && user.deletionState === 'active' ? 'active' : 'deleted';
    if (state !== 'active') deleted.add(user._id);
    const safe: UserRecord = { ...latest, _id: user._id, avatarId: null, passwordHash: '', authVersion: Math.max(Number(user.authVersion), Number(latest.authVersion)) + 1, guardVersion: Number(latest.guardVersion) + 1, updatedAt: now, deletionState: state };
    if (state !== 'active') Object.assign(safe, { emailCanonical: `${user._id}@deleted.invalid`, usernameCanonical: `deleted_${user._id.replaceAll('-', '').slice(0, 16)}`, displayName: 'Deleted account', verifiedAt: null, avatarId: null, role: 'user', privacy: { allowSearch: false, showPresence: false } });
    await users.replaceOne({ _id: user._id }, safe);
  }
  const service = new SafetyService(new AuthService(config, client, db));
  // Reserve sequence positions from the later authority boundary before making new events.
  for (const current of policy.conversations) await db.collection<{ _id: string; nextEventSeq: Long }>('conversations').updateOne({ _id: String(current['_id']) }, { $max: { nextEventSeq: current['nextEventSeq'] as Long } });
  for (const current of policy.inboxCounters) {
    if (!await users.findOne({ _id: String(current['_id']) })) continue;
    await db.collection<Document & { _id: string }>('inboxCounters').updateOne({ _id: String(current['_id']) }, { $max: { sequence: current['sequence'] }, $setOnInsert: { schemaVersion: 1, guardVersion: 0, createdAt: now } }, { upsert: true });
  }
  const tombstones = new Set(policy.messages.map(row => String(row['_id'])));
  for await (const row of db.collection<{ _id: string; senderId: string; deletedAt: Date | null }>('messages').find({ deletedAt: null })) {
    if (tombstones.has(row._id) || deleted.has(row.senderId)) {
      const session = client.startSession();
      try { await session.withTransaction(() => service.scrubMessage(row._id, 'restore', session), { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true }, timeoutMS: 10000 }); }
      finally { await session.endSession(); }
    }
  }
  const members = db.collection<MembershipRecord>('memberships'), authority = new Map(policy.memberships.map(row => [String(row['_id']), row as MembershipRecord]));
  for await (const row of members.find()) {
    const latest = authority.get(row._id), active = row.state === 'active' && latest?.state === 'active' && !deleted.has(row.userId);
    await members.updateOne({ _id: row._id }, { $set: { state: active ? 'active' : 'removed', role: latest?.role ?? row.role, invitationExpiresAt: null, updatedAt: now } });
  }
  const oldWindows = await db.collection<VisibilityRecord>('visibilityIntervals').find().limit(10001).toArray();
  if (oldWindows.length > 10000) throw new RecoveryError('Visibility budget exceeded');
  await db.collection('visibilityIntervals').deleteMany({}); let intersections = 0;
  const windows = policy.visibilityIntervals as VisibilityRecord[];
  for (const old of oldWindows) for (const latest of windows) {
    if (old.userId !== latest.userId || old.conversationId !== latest.conversationId || deleted.has(old.userId)) continue;
    const start = old.startSeq.greaterThan(latest.startSeq) ? old.startSeq : latest.startSeq;
    const end = old.endSeq === null ? latest.endSeq : latest.endSeq === null ? old.endSeq : old.endSeq.lessThan(latest.endSeq) ? old.endSeq : latest.endSeq;
    if (end && !end.greaterThan(start)) continue;
    if (++intersections > 10000) throw new RecoveryError('Visibility intersection budget exceeded');
    await db.collection<VisibilityRecord>('visibilityIntervals').insertOne({ ...old, _id: randomUUID(), startSeq: start, endSeq: end });
  }
  const states = new Map(policy.conversations.map(row => [String(row['_id']), row]));
  for await (const conversation of db.collection<ConversationRecord>('conversations').find()) {
    if (!states.has(conversation._id) || states.get(conversation._id)!['state'] !== 'active' || conversation.kind === 'group' && !await members.findOne({ conversationId: conversation._id, state: 'active', role: 'owner' })) await db.collection<ConversationRecord>('conversations').updateOne({ _id: conversation._id }, { $set: { state: 'archived' } });
  }
  // Keep the union of old/current blocks: recovery never silently unblocks a pair.
  for (const block of policy.blocks) {
    if (!await users.findOne({ _id: String(block['blockerId']) }) || !await users.findOne({ _id: String(block['blockedId']) })) continue;
    await db.collection<Document & { _id: string }>('blocks').updateOne({ _id: String(block['_id']) }, { $setOnInsert: block }, { upsert: true });
  }
  for (const pair of policy.pairGuards) {
    const blocked = pair['blockedBy'] as string[]; if (!blocked.length) continue;
    await db.collection<Document & { _id: string }>('pairGuards').updateOne({ _id: String(pair['_id']) }, { $setOnInsert: { schemaVersion: 1, userIds: pair['userIds'], guardVersion: 0, createdAt: now }, $addToSet: { blockedBy: { $each: blocked } } }, { upsert: true });
  }
  const files = new Map(policy.attachments.map(row => [String(row['_id']), row as AttachmentRecord]));
  for await (const row of db.collection<AttachmentRecord>('attachments').find()) {
    const latest = files.get(row._id);
    if (row.purpose === 'avatar' || row.state !== 'ready' || !latest || latest.state !== 'ready' || deleted.has(row.ownerId) || !!row.messageId && tombstones.has(row.messageId)) {
      await db.collection<AttachmentRecord>('attachments').updateOne({ _id: row._id }, { $set: { state: 'deleted', name: 'Deleted file', approvedKey: null, approvedSha256: null, approvedSize: 0, approvedType: null, reservedBytes: 0, sha256: '', sourceKey: `${db.databaseName}/retired/${row._id}`, sourceCleaned: true, error: 'Retired during recovery.' } });
    } else if (row.approvedKey !== latest.approvedKey || row.approvedSha256 !== latest.approvedSha256) throw new RecoveryError('Current immutable object authority differs');
  }
  for (const name of ['sessions', 'authTokens', 'pushSubscriptions', 'syncSnapshots', 'callWebhookInbox']) await db.collection(name).deleteMany({});
  await db.collection('avatarSettings').updateMany({}, { $set: { visibility: 'self' } });
  await db.collection('authEmailJobs').updateMany({}, { $set: { state: 'dead', encryptedPayload: null, leaseOwner: null, leaseUntil: new Date(0), completedAt: now } });
  await db.collection('pushJobs').updateMany({}, { $set: { state: 'skipped', outcome: 'RESTORE_SUPPRESSED', leaseOwner: null, leaseUntil: new Date(0) } });
  await db.collection('notificationJobs').updateMany({}, { $set: { state: 'published' } });
  // Explicit suppression effect prevents a pending/repeated old broker event creating fresh external work.
  for await (const event of db.collection<ControlEvent>('conversationEvents').find()) await db.collection<Document & { _id: string }>('consumerEffects').updateOne({ _id: `notification:${event._id}` }, { $setOnInsert: { schemaVersion: 1, eventId: event._id, subscription: 'notification', createdAt: now } }, { upsert: true });
  await db.collection('outbox').updateMany({ status: 'claimed' }, { $set: { status: 'pending', leaseOwner: null, leaseUntil: new Date(0), availableAt: now } });
  await db.collection('fanoutJobs').updateMany({ state: 'claimed' }, { $set: { state: 'pending', leaseOwner: null, leaseUntil: new Date(0) } });
  await db.collection('attachmentJobs').updateMany({}, { $set: { state: 'done', candidateKey: null, leaseOwner: null, leaseUntil: new Date(0) } });
  for await (const quota of db.collection<Document & { _id: string }>('attachmentQuotas').find()) {
    const ready = await db.collection<AttachmentRecord>('attachments').find({ ownerId: quota._id, state: 'ready' }).limit(129).toArray();
    await db.collection<Document & { _id: string }>('attachmentQuotas').updateOne({ _id: quota._id }, { $set: { bytes: ready.reduce((sum, row) => sum + row.approvedSize, 0) } });
  }
  for await (const row of db.collection<Document & { _id: string }>('calls').find()) await db.collection<Document & { _id: string }>('calls').updateOne({ _id: row._id }, { $set: { state: 'ended', open: false, endState: 'ended', reason: 'RESTORE_REJOIN_REQUIRED', roomName: `${db.databaseName}_retired_${row._id}`, leaseOwner: null, leaseUntil: new Date(0), updatedAt: now } });
  await db.collection('callRooms').deleteMany({}); // Retired source incarnations must never be sent to a provider by this namespace.
  await db.collection('callParticipants').updateMany({}, { $set: { state: 'left', sessionId: null, joined: false, updatedAt: now } });
  for (const id of deleted) {
    await db.collection('messageReactions').deleteMany({ userId: id });
    await db.collection<Document & { _id: string }>('accountDeletionJobs').deleteOne({ _id: id });
    await db.collection<Document & { _id: string }>('notificationPreferences').deleteOne({ _id: id });
  }
  // Every restored conversation forces old cursors through an authorized snapshot after policy changes.
  for await (const conversation of db.collection<ConversationRecord>('conversations').find()) await db.collection<Document & { _id: string }>('replayFloors').updateOne({ _id: conversation._id }, { $set: { floor: conversation.nextEventSeq }, $setOnInsert: { schemaVersion: 1, createdAt: now } }, { upsert: true });
  for await (const counter of db.collection<{ _id: string; sequence: Long }>('inboxCounters').find()) await db.collection<Document & { _id: string }>('replayFloors').updateOne({ _id: `inbox:${counter._id}` }, { $set: { floor: counter.sequence }, $setOnInsert: { schemaVersion: 1, createdAt: now } }, { upsert: true });
  await db.collection<Document & { _id: string }>('auditEvents').insertOne({ _id: randomUUID(), schemaVersion: 1, actorId: 'restore', action: 'restore.policy_applied', targetId: db.databaseName, createdAt: now });
}
