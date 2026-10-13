import { MongoClient } from 'mongodb';
import type { Config } from '@chat/config';
import type { TransactionOptions } from 'mongodb';

export const transactionOptions: TransactionOptions = {
  readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 },
  readPreference: 'primary', maxCommitTimeMS: 5000
};
export function createMongoClient(config: Config): MongoClient {
  return new MongoClient(config.MONGODB_URI, {
    maxPoolSize: config.MONGODB_POOL_SIZE, minPoolSize: 0,
    serverSelectionTimeoutMS: config.DEPENDENCY_TIMEOUT_MS, connectTimeoutMS: config.DEPENDENCY_TIMEOUT_MS,
    timeoutMS: 5000, promoteLongs: false, retryWrites: true
  });
}
export async function inspectMongo(client: MongoClient): Promise<boolean> {
  try {
    const hello = await client.db('admin').command({ hello: 1 }, { timeoutMS: 3000 });
    return hello['isWritablePrimary'] === true && typeof hello['setName'] === 'string';
  } catch { return false; }
}
