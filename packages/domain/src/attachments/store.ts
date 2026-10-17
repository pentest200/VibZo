import type { ClientSession, Db } from 'mongodb';
import type { ConversationStore } from '../conversations/store.js';
import { denied, conflict } from '../conversations/store.js';
import type { AttachmentRecord, AttachmentQuota, AttachmentJob } from './model.js';
import { attachmentReference } from './model.js';
import type { MessageRecord, MembershipRecord, ConversationRecord } from '../conversations/model.js';
import type { UserRecord } from '../auth/model.js';
export async function quota(db: Db, userId: string, session: ClientSession) {
  const row = await db.collection<AttachmentQuota>('attachmentQuotas').findOneAndUpdate({ _id: userId }, { $setOnInsert: { schemaVersion: 1, bytes: 0, createdAt: new Date() }, $inc: { guardVersion: 1 } }, { upsert: true, session, returnDocument: 'after' });
  if (!row) throw conflict('File quota is unavailable.'); return row;
}
export async function ownerAuthority(service: ConversationStore, row: AttachmentRecord, session: ClientSession) {
  const user = await service.db.collection<UserRecord>('users').findOneAndUpdate({ _id: row.ownerId, deletionState: 'active', verifiedAt: { $ne: null } }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' });
  const conversation = await service.db.collection<ConversationRecord>('conversations').findOneAndUpdate({ _id: row.conversationId, state: 'active' }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' });
  const member = await service.db.collection<MembershipRecord>('memberships').findOneAndUpdate({ conversationId: row.conversationId, userId: row.ownerId, state: 'active' }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' });
  if (!user || !conversation || !member) throw denied();
  if (conversation.directPair) { const other = conversation.directPair.split(':').find(id => id !== row.ownerId); if (!other) throw denied(); await service.guardPair(row.ownerId, other, session); }
}
export async function associateAttachments(db: Db, userId: string, conversationId: string, ids: string[], messageId: string, session: ClientSession) {
  if (new Set(ids).size !== ids.length) throw conflict('Choose each file only once.');
  for (const id of ids) {
    const changed = await db.collection<AttachmentRecord>('attachments').updateOne({ _id: id, ownerId: userId, conversationId, state: 'ready', messageId: null, expiresAt: { $gt: new Date() } }, { $set: { messageId } }, { session });
    if (!changed.matchedCount) throw conflict('A selected file is not ready or is no longer available.');
  }
}
export async function messageAttachments(db: Db, messages: MessageRecord[], session: ClientSession) {
  const rows = await db.collection<AttachmentRecord>('attachments').find({ messageId: { $in: messages.filter(row => !row.deletedAt).map(row => row._id) }, state: 'ready' }, { session }).limit(messages.length * 8 || 1).toArray();
  return new Map(messages.map(message => [message._id, rows.filter(row => row.messageId === message._id && message.attachmentIds?.includes(row._id)).map(attachmentReference)]));
}
export async function deleteMessageAttachments(db: Db, messageId: string, session: ClientSession) {
  await db.collection<AttachmentRecord>('attachments').updateMany({ messageId, state: 'ready' }, { $set: { state: 'deleting' } }, { session });
}
export async function scheduleScan(db: Db, id: string, session: ClientSession) {
  await db.collection<AttachmentJob>('attachmentJobs').insertOne({ _id: id, schemaVersion: 1, state: 'pending', attempts: 0, leaseOwner: null, leaseUntil: new Date(0), availableAt: new Date(), candidateKey: null, createdAt: new Date() }, { session });
}
