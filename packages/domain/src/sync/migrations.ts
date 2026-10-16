import type { Db, Document } from 'mongodb';
export async function syncSchemaReady(db: Db) { return !!await db.collection<{ _id: string }>('schemaMigrations').findOne({ _id: '004_sync' }); }
export async function migrateSync(db: Db, assertLease: () => Promise<void>) {
  if (await syncSchemaReady(db)) return;
  const str = { bsonType: 'string' }, date = { bsonType: 'date' }, long = { bsonType: 'long', minimum: 0 }, base = { _id: str, schemaVersion: { enum: [1] }, createdAt: date };
  const shapes: Record<string, Document> = {
    messageReactions: { conversationId: str, messageId: str, userId: str, reaction: { enum: ['like', 'heart', 'laugh', 'surprise', 'sad', 'thanks'] } },
    conversationReceipts: { conversationId: str, userId: str, delivered: long, deliveredFrom: long, read: long },
    mutationCommands: { userId: str, commandId: str, digest: str, sequence: long }, replayFloors: { floor: long },
    syncSnapshots: { userId: str, kind: { enum: ['inbox', 'conversation'] }, conversationId: { bsonType: ['string', 'null'] }, watermark: str, payload: { bsonType: ['object', 'array'] }, expiresAt: date }
  };
  for (const [name, fields] of Object.entries(shapes)) {
    await assertLease(); const validator = { $jsonSchema: { bsonType: 'object', required: Object.keys({ ...base, ...fields }), additionalProperties: false, properties: { ...base, ...fields } } };
    try { await db.createCollection(name, { validator }); }
    catch (error) { if ((error as { code?: number }).code !== 48) throw error; await db.command({ collMod: name, validator }); }
  }
  for (const [name, additions] of Object.entries({ messages: { version: long }, fanoutJobs: { state: { enum: ['pending', 'claimed', 'published'] }, leaseOwner: { bsonType: ['string', 'null'] }, leaseUntil: date, publishedAt: { bsonType: ['date', 'null'] } } })) {
    await assertLease(); const info = await db.listCollections({ name }).next();
    const validator = (info && 'options' in info ? info.options?.validator : undefined) as { $jsonSchema?: { properties?: Document } } | undefined;
    if (!validator?.$jsonSchema?.properties) throw new Error('Prior validator missing');
    Object.assign(validator.$jsonSchema.properties, additions); await db.command({ collMod: name, validator });
  }
  await db.collection('messageReactions').createIndex({ messageId: 1, userId: 1, reaction: 1 }, { unique: true, name: 'unique_user_reaction' });
  await db.collection('messageReactions').createIndex({ conversationId: 1, messageId: 1 }, { name: 'conversation_reactions' });
  await db.collection('conversationReceipts').createIndex({ conversationId: 1, userId: 1 }, { unique: true, name: 'unique_member_receipt' });
  await db.collection('mutationCommands').createIndex({ userId: 1, commandId: 1 }, { unique: true, name: 'unique_mutation_command' });
  await db.collection('syncSnapshots').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: 'ephemeral_snapshot_expiry' });
  await db.collection('syncSnapshots').createIndex({ userId: 1, expiresAt: 1 }, { name: 'snapshot_quota' });
  await db.collection('fanoutJobs').createIndex({ state: 1, leaseUntil: 1, createdAt: 1 }, { name: 'fanout_claim' });
  await assertLease(); await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').insertOne({ _id: '004_sync', appliedAt: new Date() });
}
