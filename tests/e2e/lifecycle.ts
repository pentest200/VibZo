import { createConnection } from 'node:net';
import { loadConfig } from '@chat/config';
import type { Config } from '@chat/config';
import { AttachmentStorage, BrokerTransport, LiveKitProvider, createMongoClient } from '@chat/domain';
import { browserEndpoints } from './endpoints.js';

export interface FixtureIdentity { database: string; runId: string }
function fixtureConfig(identity: FixtureIdentity): Config {
  if (!/^chat_e2e_auth_[a-f0-9]{32}$/.test(identity.database) || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(identity.runId)) throw new Error('Invalid isolated browser fixture identity');
  return loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: identity.database, WEB_ORIGIN: browserEndpoints().origin });
}
export function fixtureIdentity(): FixtureIdentity {
  const identity = { database: process.env['E2E_DATABASE'] ?? '', runId: process.env['E2E_RUN_ID'] ?? '' };
  fixtureConfig(identity); return identity;
}
export async function claimFixture(identity: FixtureIdentity) {
  const config = fixtureConfig(identity), client = createMongoClient(config);
  try {
    await client.connect();
    if ((await client.db('admin').admin().listDatabases()).databases.some(row => row.name === identity.database)) throw new Error('Browser fixture database already exists');
    await client.db(identity.database).collection<{ _id: string; runId: string; createdAt: Date }>('e2eFixtureOwner')
      .insertOne({ _id: 'playwright', runId: identity.runId, createdAt: new Date() }, { writeConcern: { w: 'majority', j: true } });
  } finally { await client.close(); }
  return config;
}
async function listening(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => { if (error.code === 'ECONNREFUSED') finish(false); else { socket.destroy(); reject(new Error('Cannot establish browser server shutdown')); } });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Browser server shutdown probe timed out')); });
  });
}
export async function cleanupFixture(identity: FixtureIdentity) {
  const config = fixtureConfig(identity), client = createMongoClient(config), storage = new AttachmentStorage(config);
  try {
    await client.connect(); const db = client.db(identity.database);
    const owner = await db.collection<{ _id: string; runId: string }>('e2eFixtureOwner').findOne({ _id: 'playwright' });
    if (!owner) {
      if ((await client.db('admin').admin().listDatabases()).databases.some(row => row.name === identity.database)) throw new Error('Refusing unowned browser fixture cleanup');
      return;
    }
    if (owner.runId !== identity.runId) throw new Error('Refusing foreign browser fixture cleanup');
    const ports = browserEndpoints();
    if ((await Promise.all([ports.api, ports.gateway, ports.worker, ports.web, 16380, 16381].map(listening))).some(Boolean)) throw new Error('Browser servers must stop before fixture cleanup');
    const rooms = await db.collection<{ _id: string }>('callRooms').find().toArray();
    if (rooms.some(room => !room._id.startsWith(`${identity.database}_call_`))) throw new Error('Refusing foreign browser media room cleanup');
    const media = new LiveKitProvider(config);
    for (const room of rooms) await media.removeRoom(room._id);
    for (const bucket of [config.S3_QUARANTINE_BUCKET, config.S3_APPROVED_BUCKET]) {
      let cursor: string | undefined;
      do { const page = await storage.list(bucket, cursor); for (const object of page.Contents ?? []) if (object.Key) await storage.remove(bucket, object.Key); cursor = page.NextContinuationToken; } while (cursor);
    }
    const broker = await BrokerTransport.open(config);
    try { await broker.deleteTestTopology(); } finally { await broker.close(); }
    // No application process remains to recreate a counter or redeclare a queue.
    await db.dropDatabase();
  } finally { storage.close(); await client.close(); }
}
