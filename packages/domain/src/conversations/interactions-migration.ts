import type { Db, Document } from 'mongodb';

export const interactionsSchemaReady = async (db: Db) => !!await db.collection<{ _id: string }>('schemaMigrations').findOne({ _id: '011_chat_interactions' });
export async function migrateChatInteractions(db: Db, assertLease: () => Promise<void>) {
  if (await interactionsSchemaReady(db)) return;
  for (const name of ['memberships', 'messages']) {
    await assertLease(); const info = await db.listCollections({ name }).next();
    const validator = (info && 'options' in info ? info.options?.validator : undefined) as { $jsonSchema?: { properties?: Document } } | undefined;
    if (!validator?.$jsonSchema?.properties) throw new Error(`Prior ${name} validator missing`);
    Object.assign(validator.$jsonSchema.properties, name === 'memberships' ? { pinned: { bsonType: 'bool' }, archived: { bsonType: 'bool' } } : { pinned: { bsonType: 'bool' }, hiddenFor: { bsonType: 'array', maxItems: 50, uniqueItems: true, items: { bsonType: 'string' } } });
    await db.command({ collMod: name, validator });
  }
  await assertLease();
  await db.collection('messages').createIndex({ conversationId: 1, pinned: 1, creationSeq: -1 }, { name: 'conversation_pins' });
  await assertLease(); await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').insertOne({ _id: '011_chat_interactions', appliedAt: new Date() });
}
