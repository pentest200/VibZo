import type { Db, Document } from 'mongodb';

export const experienceSchemaReady = async (db: Db) => !!await db.collection<{ _id: string }>('schemaMigrations').findOne({ _id: '010_chat_experience' });
/** Additive DDL: preserve every prior validator field and existing record. */
export async function migrateChatExperience(db: Db, assertLease: () => Promise<void>) {
  if (await experienceSchemaReady(db)) return;
  for (const name of ['memberships', 'attachments', 'conversations']) {
    await assertLease(); const info = await db.listCollections({ name }).next();
    const validator = (info && 'options' in info ? info.options?.validator : undefined) as { $jsonSchema?: { properties?: Document } } | undefined;
    if (!validator?.$jsonSchema?.properties) throw new Error(`Prior ${name} validator missing`);
    if (name === 'memberships') validator.$jsonSchema.properties['hidden'] = { bsonType: 'bool' };
    else if (name === 'attachments') validator.$jsonSchema.properties['kind'] = { enum: ['jpeg', 'png', 'webp', 'pdf', 'text', 'gif', 'mp4', 'webm', 'mp3', 'wav', 'ogg'] };
    else Object.assign(validator.$jsonSchema.properties, { deletionRequestedAt: { bsonType: 'date' }, historyPurgedAt: { bsonType: 'date' } });
    await db.command({ collMod: name, validator });
  }
  await db.collection('conversations').createIndex({ deletionRequestedAt: 1, _id: 1 }, { name: 'group_deletion_requested', partialFilterExpression: { deletionRequestedAt: { $exists: true } } });
  await assertLease(); await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').insertOne({ _id: '010_chat_experience', appliedAt: new Date() });
}
