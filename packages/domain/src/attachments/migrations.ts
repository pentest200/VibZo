import type { Db, Document } from 'mongodb';
export const attachmentSchemaReady = async (db: Db) => !!await db.collection<{ _id: string }>('schemaMigrations').findOne({ _id: '005_attachments' });
export async function migrateAttachments(db: Db, assertLease: () => Promise<void>) {
  if (await attachmentSchemaReady(db)) return;
  const str = { bsonType: 'string' }, date = { bsonType: 'date' }, num = { bsonType: ['int', 'double'], minimum: 0 }, maybe = { bsonType: ['string', 'null'] }, base = { _id: str, schemaVersion: { enum: [1] }, createdAt: date };
  const shapes: Record<string, Document> = {
    attachments: { ownerId: str, conversationId: str, name: str, kind: { enum: ['jpeg', 'png', 'webp', 'pdf', 'text'] }, size: num, sha256: str,
      state: { enum: ['pending', 'uploaded', 'processing', 'ready', 'rejected', 'deleting', 'deleted'] }, sourceKey: str, approvedKey: maybe, approvedSize: num, approvedType: maybe, approvedSha256: maybe, sourceCleaned: { bsonType: 'bool' }, messageId: maybe,
      reservedBytes: num, error: str, uploadExpiresAt: date, expiresAt: date },
    attachmentQuotas: { bytes: num, guardVersion: num }, attachmentCommands: { userId: str, digest: str, attachmentId: str },
    attachmentJobs: { state: { enum: ['pending', 'claimed', 'done', 'failed'] }, attempts: num, leaseOwner: maybe, leaseUntil: date, availableAt: date, candidateKey: maybe }
  };
  for (const [name, fields] of Object.entries(shapes)) {
    await assertLease(); const validator = { $jsonSchema: { bsonType: 'object', required: Object.keys({ ...base, ...fields }), additionalProperties: false, properties: { ...base, ...fields } } };
    try { await db.createCollection(name, { validator }); } catch (error) { if ((error as { code?: number }).code !== 48) throw error; await db.command({ collMod: name, validator }); }
  }
  await db.collection('attachments').createIndex({ ownerId: 1, conversationId: 1, state: 1, createdAt: 1 }, { name: 'own_uploads' });
  await db.collection('attachments').createIndex({ state: 1, expiresAt: 1 }, { name: 'attachment_expiry' });
  await db.collection('attachments').createIndex({ messageId: 1 }, { name: 'message_attachments' });
  await db.collection('attachments').createIndex({ sourceKey: 1 }, { unique: true, name: 'unique_upload_key' });
  await db.collection('attachments').createIndex({ approvedKey: 1 }, { unique: true, partialFilterExpression: { approvedKey: { $type: 'string' } }, name: 'unique_approved_key' });
  await db.collection('attachmentJobs').createIndex({ state: 1, availableAt: 1, leaseUntil: 1 }, { name: 'attachment_job_claim' });
  await db.collection('attachmentJobs').createIndex({ candidateKey: 1 }, { unique: true, partialFilterExpression: { candidateKey: { $type: 'string' } }, name: 'candidate_key' });
  await db.collection('attachmentJobs').createIndex({ state: 1, createdAt: 1 }, { name: 'attachment_oldest_job' });
  await db.collection('attachments').createIndex({ state: 1, sourceCleaned: 1, uploadExpiresAt: 1 }, { name: 'source_cleanup' });
  const info = await db.listCollections({ name: 'messages' }).next();
  const validator = (info && 'options' in info ? info.options?.validator : undefined) as { $jsonSchema?: { properties?: Document } } | undefined;
  if (!validator?.$jsonSchema?.properties) throw new Error('Prior message validator missing');
  validator.$jsonSchema.properties['attachmentIds'] = { bsonType: 'array', items: str, maxItems: 8, uniqueItems: true };
  await db.command({ collMod: 'messages', validator }); await assertLease();
  await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').insertOne({ _id: '005_attachments', appliedAt: new Date() });
}
