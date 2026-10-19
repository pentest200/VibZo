import type { Db } from 'mongodb';
import { unavailable } from '../auth/errors.js';
export async function recoveryReady(db: Db) {
  const state = await db.collection<{ _id: string; state: string }>('restoreControl').findOne({ _id: 'state' });
  return !state || state.state === 'ready';
}
export async function assertRecoveryReady(db: Db) { if (!await recoveryReady(db)) throw unavailable(); }
