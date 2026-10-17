import type { ClientSession, Db } from 'mongodb';
// Deletion waits for all media incarnations for which this user obtained credentials.
export async function pendingCallCleanup(db: Db, userId: string, session: ClientSession) {
  const pending = await db.collection('callRooms').aggregate([
    { $match: { state: { $ne: 'deleted' } } },
    { $lookup: { from: 'callParticipants', let: { call: '$callId', gen: '$generation' }, pipeline: [
      { $match: { userId, $expr: { $and: [{ $eq: ['$callId', '$$call'] }, { $gte: ['$roomGeneration', '$$gen'] }] } } }, { $limit: 1 }
    ], as: '_authorized' } }, { $match: { '_authorized.0': { $exists: true } } }, { $limit: 1 }, { $project: { _id: 1 } }
  ], { session, maxTimeMS: 2000 }).toArray(); return !!pending.length;
}
