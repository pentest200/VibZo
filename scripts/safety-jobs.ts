import { loadConfig } from '@chat/config';
import { createMongoClient, safetySchemaReady } from '@chat/domain';
import type { DeletionJob, PushJob, UserRecord } from '@chat/domain';
import { idSchema } from '@chat/contracts';
const client = createMongoClient(loadConfig()), db = client.db(loadConfig().MONGODB_DATABASE);
try {
  await client.connect(); if (!await safetySchemaReady(db)) throw new Error('Apply migration 006 first');
  const action = process.argv[2] ?? 'inspect';
  if (action === 'retry-deletion') {
    const id = idSchema.parse(process.argv[3]);
    if (!await db.collection<UserRecord>('users').findOne({ _id: id, deletionState: 'deleting' })) throw new Error('Account is not awaiting deletion');
    const result = await db.collection<DeletionJob>('accountDeletionJobs').updateOne({ _id: id, state: 'failed' }, { $set: { state: 'pending', attempts: 0, leaseOwner: null, leaseUntil: new Date(0), availableAt: new Date(), outcome: 'OPERATOR_RETRY' } });
    if (!result.matchedCount) throw new Error('No failed deletion job found');
    console.log('Deletion retry queued.');
  } else if (action === 'inspect') {
    for (const name of ['accountDeletionJobs', 'pushJobs'] as const) {
      const rows = await db.collection<DeletionJob | PushJob>(name).find({ state: { $in: ['pending', 'claimed', 'failed'] } }, { projection: { _id: 1, state: 1, attempts: 1, outcome: 1, createdAt: 1, availableAt: 1, leaseUntil: 1 } }).sort({ createdAt: 1 }).limit(50).toArray();
      console.log(JSON.stringify({ collection: name, jobs: rows }));
    }
  } else throw new Error('Usage: safety-jobs.ts inspect|retry-deletion <account UUID>');
} finally { await client.close(); }
