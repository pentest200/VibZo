import { AttachmentStorage, createMongoClient, runMigrations } from '@chat/domain';
import { claimFixture, fixtureIdentity } from './lifecycle.js';
export default async function setup() {
  const identity = fixtureIdentity(), name = identity.database;
  const config = await claimFixture(identity);
  const storage = new AttachmentStorage(config);
  try { await storage.configureCors(); } finally { storage.close(); }
  const client = createMongoClient(config);
  try { await client.connect(); await runMigrations(client.db(name)); } finally { await client.close(); }
  const deadline = Date.now() + 30000; let ready = false;
  while (Date.now() < deadline) {
    try { ready = (await fetch('http://127.0.0.1:3002/health/ready', { signal: AbortSignal.timeout(2000) })).status === 200; } catch { ready = false; }
    if (ready) break; await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('Messaging worker did not become ready after the isolated migration');
}
