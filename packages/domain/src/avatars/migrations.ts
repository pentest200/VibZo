import type { Db, Document } from 'mongodb';
export const avatarSchemaReady = async (db: Db) => !!await db.collection<{ _id: string }>('schemaMigrations').findOne({ _id: '009_avatars' });
export async function migrateAvatars(db: Db, assertLease: () => Promise<void>) {
  if (await avatarSchemaReady(db)) return;
  await assertLease();
  const info = await db.listCollections({ name: 'attachments' }).next();
  const validator = (info && 'options' in info ? info.options?.validator : undefined) as { $jsonSchema?: { properties?: Document; oneOf?: Document[] } } | undefined;
  if (!validator?.$jsonSchema?.properties) throw new Error('Prior attachment validator missing');
  Object.assign(validator.$jsonSchema.properties, { conversationId: { bsonType: ['string', 'null'] }, purpose: { enum: ['avatar'] }, avatarActive: { bsonType: 'bool' } });
  validator.$jsonSchema.oneOf = [
    { required: ['purpose', 'avatarActive'], properties: { conversationId: { bsonType: 'null' }, messageId: { bsonType: 'null' } } },
    { not: { anyOf: [{ required: ['purpose'] }, { required: ['avatarActive'] }] }, properties: { conversationId: { bsonType: 'string' } } }
  ];
  await db.command({ collMod: 'attachments', validator });
  const str = { bsonType: 'string' }, base = { _id: str, schemaVersion: { enum: [1] }, createdAt: { bsonType: 'date' } };
  const shapes: Record<string, Document> = {
    avatarSettings: { visibility: { enum: ['self', 'conversations'] } },
    avatarCommands: { userId: str, digest: str, avatarId: { bsonType: ['string', 'null'] } }
  };
  for (const [name, fields] of Object.entries(shapes)) {
    await assertLease(); const properties = { ...base, ...fields }, validator = { $jsonSchema: { bsonType: 'object', required: Object.keys(properties), additionalProperties: false, properties } };
    try { await db.createCollection(name, { validator }); } catch (error) { if ((error as { code?: number }).code !== 48) throw error; await db.command({ collMod: name, validator }); }
  }
  await db.collection('attachments').createIndex({ ownerId: 1, purpose: 1, state: 1, createdAt: 1 }, { name: 'avatar_candidates' });
  await assertLease(); await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').insertOne({ _id: '009_avatars', appliedAt: new Date() });
}
