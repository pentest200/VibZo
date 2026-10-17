import type { Db, Document } from 'mongodb';
export const safetySchemaReady = async (db: Db) => !!await db.collection<{ _id: string }>('schemaMigrations').findOne({ _id: '006_safety' });
export async function migrateSafety(db: Db, assertLease: () => Promise<void>) {
  if (await safetySchemaReady(db)) return;
  const str = { bsonType: 'string' }, date = { bsonType: 'date' }, num = { bsonType: ['int', 'double'], minimum: 0 }, maybe = { bsonType: ['string', 'null'] };
  const base = { _id: str, schemaVersion: { enum: [1] }, createdAt: date };
  const job = { attempts: num, leaseOwner: maybe, leaseUntil: date, availableAt: date, outcome: str };
  const shapes: Record<string, Document> = {
    notificationPreferences: { enabled: { bsonType: 'bool' } },
    pushSubscriptions: { userId: str, sessionId: str, endpointHash: str, encrypted: str, expiresAt: date },
    pushJobs: { ...job, userId: str, subscriptionId: str, eventId: str, conversationId: str, expiresAt: date, state: { enum: ['pending', 'claimed', 'sent', 'skipped', 'failed'] } },
    reports: { reporterId: str, commandId: str, digest: str, conversationId: str, messageId: maybe, reason: { enum: ['spam', 'harassment', 'unsafe', 'other'] }, state: { enum: ['open', 'dismissed', 'removed'] } },
    accountDeletionJobs: { ...job, state: { enum: ['pending', 'claimed', 'done', 'failed'] } }
  };
  for (const [name, fields] of Object.entries(shapes)) {
    await assertLease(); const validator = { $jsonSchema: { bsonType: 'object', required: Object.keys({ ...base, ...fields }), additionalProperties: false, properties: { ...base, ...fields } } };
    try { await db.createCollection(name, { validator }); } catch (error) { if ((error as { code?: number }).code !== 48) throw error; await db.command({ collMod: name, validator }); }
  }
  for (const [name, additions] of Object.entries({
    users: { deletionState: { enum: ['active', 'deleting', 'deleted'] } },
    notificationJobs: { state: { enum: ['pending', 'published'] } }
  })) {
    await assertLease(); const info = await db.listCollections({ name }).next();
    const validator = (info && 'options' in info ? info.options?.validator : undefined) as { $jsonSchema?: { properties?: Document } } | undefined;
    if (!validator?.$jsonSchema?.properties) throw new Error('Prior validator missing');
    Object.assign(validator.$jsonSchema.properties, additions); await db.command({ collMod: name, validator });
  }
  await db.collection('pushSubscriptions').createIndex({ endpointHash: 1 }, { unique: true, name: 'unique_push_endpoint' });
  await db.collection('pushSubscriptions').createIndex({ userId: 1, sessionId: 1 }, { unique: true, name: 'one_subscription_per_session' });
  await db.collection('pushSubscriptions').createIndex({ expiresAt: 1 }, { name: 'push_expiry', expireAfterSeconds: 0 });
  await db.collection('pushJobs').createIndex({ state: 1, availableAt: 1, leaseUntil: 1 }, { name: 'push_claim' });
  await db.collection('pushJobs').createIndex({ userId: 1, createdAt: -1 }, { name: 'push_account_outcomes' });
  await db.collection('reports').createIndex({ reporterId: 1, commandId: 1 }, { unique: true, name: 'unique_report_command' });
  await db.collection('reports').createIndex({ state: 1, createdAt: 1 }, { name: 'moderation_queue' });
  await db.collection('reports').createIndex({ reporterId: 1, createdAt: 1 }, { name: 'report_admission' });
  await db.collection('accountDeletionJobs').createIndex({ state: 1, availableAt: 1, leaseUntil: 1 }, { name: 'deletion_claim' });
  await db.collection('messages').createIndex({ senderId: 1, deletedAt: 1, createdAt: 1 }, { name: 'authored_cleanup' });
  await db.collection('messages').createIndex({ deletedAt: 1, createdAt: 1 }, { name: 'content_retention' });
  await assertLease(); await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').insertOne({ _id: '006_safety', appliedAt: new Date() });
}
