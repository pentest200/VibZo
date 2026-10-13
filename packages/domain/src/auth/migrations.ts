import type { Db, Document } from 'mongodb';

const date = { bsonType: 'date' }; const string = { bsonType: 'string' };
const nullableDate = { bsonType: ['date', 'null'] }; const nullableString = { bsonType: ['string', 'null'] };
const number = { bsonType: ['int', 'double'], minimum: 0 };
const base = { _id: string, schemaVersion: { enum: [1] }, createdAt: date };
const definitions: Record<string, { required: string[]; properties: Document }> = {
  users: { required: ['emailCanonical','usernameCanonical','passwordHash','verifiedAt','privacy','authVersion','guardVersion','role','deletionState','updatedAt','displayName','avatarId'],
    properties: { emailCanonical: string, usernameCanonical: string, displayName: string, passwordHash: string, verifiedAt: nullableDate,
      privacy: { bsonType: 'object', required: ['showPresence','allowSearch'], additionalProperties: false, properties: { showPresence: { bsonType: 'bool' }, allowSearch: { bsonType: 'bool' } } },
      authVersion: number, guardVersion: number, role: { enum: ['user','moderator'] }, deletionState: { enum: ['active'] }, avatarId: nullableString, updatedAt: date } },
  sessions: { required: ['tokenHash','csrfHash','userId','authVersion','deviceLabel','expiresAt','revokedAt','guardVersion'],
    properties: { tokenHash: string, csrfHash: string, userId: string, authVersion: number, deviceLabel: string, expiresAt: date, revokedAt: nullableDate, guardVersion: number } },
  authTokens: { required: ['hash','userId','authVersion','purpose','expiresAt','usedAt'],
    properties: { hash: string, userId: string, authVersion: number, purpose: { enum: ['verify','reset'] }, expiresAt: date, usedAt: nullableDate } },
  authEmailJobs: { required: ['userId','state','encryptedPayload','availableAt','leaseUntil','leaseOwner','attempts','expiresAt','completedAt'],
    properties: { userId: string, state: { enum: ['pending','sending','sent','dead'] }, encryptedPayload: nullableString,
      availableAt: date, leaseUntil: date, leaseOwner: nullableString, attempts: number, expiresAt: date, completedAt: nullableDate } },
  auditEvents: { required: ['actorId','action','targetId'], properties: { actorId: string, action: string, targetId: string } }
};
export async function migrateAuth(db: Db): Promise<void> {
  // An older migration must never replace a validator expanded by a later release.
  if (await authSchemaReady(db)) return;
  for (const [name, definition] of Object.entries(definitions)) {
    const validator = { $jsonSchema: { bsonType: 'object', required: ['_id','schemaVersion','createdAt',...definition.required], additionalProperties: false, properties: { ...base, ...definition.properties } } };
    try { await db.createCollection(name, { validator, validationLevel: 'strict', validationAction: 'error' }); }
    catch (error) {
      if ((error as { code?: number }).code !== 48) throw error;
      await db.command({ collMod: name, validator, validationLevel: 'strict', validationAction: 'error' });
    }
  }
  await db.collection('users').createIndexes([
    { key: { emailCanonical: 1 }, name: 'email_unique', unique: true },
    { key: { usernameCanonical: 1 }, name: 'username_unique', unique: true }
  ]);
  await db.collection('sessions').createIndexes([
    { key: { tokenHash: 1 }, name: 'token_hash_unique', unique: true },
    { key: { userId: 1, revokedAt: 1, expiresAt: 1 }, name: 'active_user_sessions' },
    { key: { expiresAt: 1 }, name: 'session_expiry_cleanup', expireAfterSeconds: 0 }
  ]);
  await db.collection('authTokens').createIndexes([
    { key: { hash: 1 }, name: 'auth_token_hash_unique', unique: true },
    { key: { userId: 1, purpose: 1, usedAt: 1 }, name: 'user_token_purpose' },
    { key: { expiresAt: 1 }, name: 'token_expiry_cleanup', expireAfterSeconds: 0 }
  ]);
  await db.collection('authEmailJobs').createIndex({ state: 1, availableAt: 1, leaseUntil: 1 }, { name: 'email_lease_claim' });
  await db.collection('auditEvents').createIndex({ actorId: 1, createdAt: -1 }, { name: 'actor_audit' });
  await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').updateOne({ _id: '001_auth' }, { $setOnInsert: { appliedAt: new Date() } }, { upsert: true });
}
export async function authSchemaReady(db: Db): Promise<boolean> {
  return !!await db.collection<{ _id: string }>('schemaMigrations').findOne({ _id: '001_auth' });
}
