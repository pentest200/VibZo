import type { Db, Document } from 'mongodb';
export const callSchemaReady = async (db: Db) => !!await db.collection<{ _id: string }>('schemaMigrations').findOne({ _id: '007_calls' });
export async function migrateCalls(db: Db, assertLease: () => Promise<void>) {
  if (await callSchemaReady(db)) return;
  const str = { bsonType: 'string' }, date = { bsonType: 'date' }, num = { bsonType: ['int', 'double'], minimum: 0 }, bool = { bsonType: 'bool' }, maybe = { bsonType: ['string', 'null'] }, base = { _id: str, schemaVersion: { enum: [1] }, createdAt: date };
  const shapes: Record<string, Document> = {
    calls: { conversationId: str, creatorId: str, mode: { enum: ['voice', 'video'] }, state: { enum: ['ringing', 'active', 'ending', 'ended', 'cancelled', 'declined', 'timed_out'] }, open: bool,
      endState: { enum: ['ended', 'cancelled', 'declined', 'timed_out'] }, reason: str, generation: num, roomName: str, creationSeq: { bsonType: 'long', minimum: 0 },
      updatedAt: date, expiresAt: date, ringUntil: date, emptySince: { bsonType: ['date', 'null'] }, guardVersion: num, leaseOwner: maybe, leaseUntil: date, availableAt: date, failures: num },
    callParticipants: { callId: str, userId: str, sessionId: maybe, authVersion: num, state: { enum: ['invited', 'accepted', 'declined', 'left', 'removed'] }, joined: bool, roomGeneration: num, tokenAvailableAt: date, updatedAt: date },
    callRooms: { callId: str, generation: num, state: { enum: ['pending', 'ready', 'deleting', 'deleted'] } },
    callCommands: { userId: str, commandId: str, digest: str, callId: str },
    callWebhookInbox: { roomName: str, kind: str, digest: str, state: { enum: ['pending', 'done'] } }
  };
  for (const [name, fields] of Object.entries(shapes)) {
    await assertLease(); const validator = { $jsonSchema: { bsonType: 'object', required: Object.keys({ ...base, ...fields }), additionalProperties: false, properties: { ...base, ...fields } } };
    try { await db.createCollection(name, { validator }); } catch (error) { if ((error as { code?: number }).code !== 48) throw error; await db.command({ collMod: name, validator }); }
  }
  await db.collection('calls').createIndex({ conversationId: 1 }, { unique: true, partialFilterExpression: { open: true }, name: 'one_open_call_per_conversation' });
  await db.collection('calls').createIndex({ open: 1, availableAt: 1, leaseUntil: 1 }, { name: 'call_reconciliation' });
  await db.collection('calls').createIndex({ conversationId: 1, createdAt: -1 }, { name: 'call_history' });
  await db.collection('callParticipants').createIndex({ callId: 1, userId: 1 }, { unique: true, name: 'call_user_unique' });
  await db.collection('callParticipants').createIndex({ userId: 1 }, { unique: true, partialFilterExpression: { state: 'accepted' }, name: 'one_accepted_call_per_user' });
  await db.collection('callParticipants').createIndex({ userId: 1, state: 1, createdAt: -1 }, { name: 'user_call_invitations' });
  await db.collection('callRooms').createIndex({ callId: 1, generation: 1 }, { unique: true, name: 'call_incarnation_unique' });
  await db.collection('callRooms').createIndex({ state: 1, callId: 1 }, { name: 'call_room_cleanup' });
  await db.collection('callCommands').createIndex({ userId: 1, commandId: 1 }, { unique: true, name: 'call_action_idempotency' });
  await db.collection('callWebhookInbox').createIndex({ state: 1, createdAt: 1 }, { name: 'call_webhook_pending' });
  await db.collection<{ _id: string; schemaVersion: 1; guardVersion: number; createdAt: Date }>('outboxAdmission').updateOne({ _id: 'calls' }, { $setOnInsert: { schemaVersion: 1, guardVersion: 0, createdAt: new Date() } }, { upsert: true });
  await assertLease(); await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').insertOne({ _id: '007_calls', appliedAt: new Date() });
}
