import type { Db, Document } from 'mongodb';
const str = { bsonType: 'string' }, date = { bsonType: 'date' }, long = { bsonType: 'long', minimum: 0 };
export async function messagingSchemaReady(db: Db) { return !!await db.collection<{ _id: string }>('schemaMigrations').findOne({ _id: '003_messaging' }); }
export async function migrateMessaging(db: Db, assertLease: () => Promise<void>) {
  if (await messagingSchemaReady(db)) return;
  const base = { _id: str, schemaVersion: { enum: [1] }, createdAt: date };
  const job = { eventId: str, conversationId: str, sequence: long, state: { enum: ['pending'] } };
  const shapes: Record<string, Document> = {
    outboxAdmission: { guardVersion: { bsonType: ['int', 'double'], minimum: 0 } },
    messageCommands: { conversationId: str, senderId: str, clientMessageId: str, digest: str, messageId: str, eventId: str, creationSeq: long },
    consumerEffects: { eventId: str, subscription: { enum: ['fanout', 'notification'] } },
    fanoutJobs: job, notificationJobs: job
  };
  for (const [name, fields] of Object.entries(shapes)) {
    await assertLease(); const validator = { $jsonSchema: { bsonType: 'object', required: Object.keys({ ...base, ...fields }), additionalProperties: false, properties: { ...base, ...fields } } };
    try { await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' }); }
    catch (error) { if ((error as { code?: number }).code !== 48) throw error; await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' }); }
  }
  await assertLease();
  // Preserve 002 fields and fixtures. The reply field is additive and optional for existing messages.
  const metadata = await db.listCollections({ name: 'messages' }).next();
  const validator = (metadata && 'options' in metadata ? metadata.options?.validator : undefined) as { $jsonSchema?: { properties?: Document } } | undefined;
  if (!validator?.$jsonSchema?.properties) throw new Error('002 messages validator is required');
  validator.$jsonSchema.properties['replyToId'] = { bsonType: ['string', 'null'] };
  await db.command({ collMod: 'messages', validator, validationLevel: 'strict', validationAction: 'error' });
  await db.collection('messageCommands').createIndex({ conversationId: 1, senderId: 1, clientMessageId: 1 }, { name: 'accepted_message_command_unique', unique: true });
  await db.collection('consumerEffects').createIndex({ subscription: 1, eventId: 1 }, { name: 'consumer_event_unique', unique: true });
  await db.collection('outbox').createIndex({ status: 1, createdAt: 1 }, { name: 'outbox_oldest_pending' });
  for (const name of ['fanoutJobs', 'notificationJobs']) {
    await assertLease(); await db.collection(name).createIndex({ eventId: 1 }, { name: 'projection_event_unique', unique: true });
    await db.collection(name).createIndex({ state: 1, createdAt: 1 }, { name: 'pending_projection' });
  }
  await db.collection<{ _id: string; schemaVersion: number; guardVersion: number; createdAt: Date }>('outboxAdmission').updateOne({ _id: 'global' }, { $setOnInsert: { schemaVersion: 1, guardVersion: 0, createdAt: new Date() } }, { upsert: true });
  for (const subscription of ['fanout', 'notification']) await db.collection<{ _id: string; schemaVersion: number; guardVersion: number; createdAt: Date }>('outboxAdmission').updateOne({ _id: `projection:${subscription}` }, { $setOnInsert: { schemaVersion: 1, guardVersion: 0, createdAt: new Date() } }, { upsert: true });
  await assertLease();
  await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').updateOne({ _id: '003_messaging' }, { $setOnInsert: { appliedAt: new Date() } }, { upsert: true });
}
