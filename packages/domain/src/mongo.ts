import { MongoClient } from 'mongodb';
import type { Config } from '@chat/config';
import type { TransactionOptions } from 'mongodb';

export const transactionOptions: TransactionOptions = {
  readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', j: true, wtimeoutMS: 5000 },
  readPreference: 'primary', maxCommitTimeMS: 5000
};
interface PoolState { limit: number; connections: number; checkedOut: number; waiting: number; checkoutFailures: number; clears: number }
const pools = new WeakMap<MongoClient, PoolState>();
export function mongoPoolMetrics(client: MongoClient) {
  const state = pools.get(client);
  return state ? Object.entries(state).map(([key, value]) => `chat_mongo_pool_${key.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`)} ${value}\n`).join('') : '';
}
export function createMongoClient(config: Config): MongoClient {
  const client = new MongoClient(config.MONGODB_URI, {
    maxPoolSize: config.MONGODB_POOL_SIZE, minPoolSize: 0,
    serverSelectionTimeoutMS: config.DEPENDENCY_TIMEOUT_MS, connectTimeoutMS: config.DEPENDENCY_TIMEOUT_MS,
    timeoutMS: 5000, promoteLongs: false, retryWrites: true
  });
  const state: PoolState = { limit: config.MONGODB_POOL_SIZE, connections: 0, checkedOut: 0, waiting: 0, checkoutFailures: 0, clears: 0 }; pools.set(client, state);
  client.on('connectionCreated', () => { state.connections++; });
  client.on('connectionClosed', () => { state.connections = Math.max(0, state.connections - 1); });
  client.on('connectionCheckOutStarted', () => { state.waiting++; });
  client.on('connectionCheckedOut', () => { state.waiting = Math.max(0, state.waiting - 1); state.checkedOut++; });
  client.on('connectionCheckedIn', () => { state.checkedOut = Math.max(0, state.checkedOut - 1); });
  client.on('connectionCheckOutFailed', () => { state.waiting = Math.max(0, state.waiting - 1); state.checkoutFailures++; });
  client.on('connectionPoolCleared', () => { state.clears++; });
  return client;
}
export async function inspectMongo(client: MongoClient): Promise<boolean> {
  try {
    const hello = await client.db('admin').command({ hello: 1 }, { timeoutMS: 3000 });
    return hello['isWritablePrimary'] === true && typeof hello['setName'] === 'string';
  } catch { return false; }
}
