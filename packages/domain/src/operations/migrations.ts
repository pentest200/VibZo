import type { Db, Document } from 'mongodb';
export const operationsSchemaReady = async (db: Db) => !!await db.collection<{ _id: string }>('schemaMigrations').findOne({ _id: '008_operations' });

// Expand the existing validator only; old rows and old v1 writers remain valid.
export async function migrateOperations(db: Db, assertLease: () => Promise<void>) {
  if (await operationsSchemaReady(db)) return;
  await assertLease();
  const info = await db.listCollections({ name: 'outbox' }).next();
  const validator = (info && 'options' in info ? info.options?.validator : undefined) as Document | undefined;
  if (!validator?.['$jsonSchema']?.properties) throw new Error('Outbox validator is missing');
  validator['$jsonSchema'].properties.traceparent = { bsonType: 'string', pattern: '^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-0[01]$' };
  await db.command({ collMod: 'outbox', validator });
  await assertLease();
  await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').insertOne({ _id: '008_operations', appliedAt: new Date() });
}
