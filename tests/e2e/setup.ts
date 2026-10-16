import { loadConfig } from '@chat/config';
import { BrokerTransport, createMongoClient, runMigrations } from '@chat/domain';
export default async function setup() {
  const name = process.env['E2E_DATABASE'];
  if (!name?.startsWith('chat_e2e_auth_')) throw new Error('E2E requires an isolated auth test database');
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: name });
  const client = createMongoClient(config);
  try { await client.connect(); await runMigrations(client.db(name)); } finally { await client.close(); }
  const deadline = Date.now() + 30000; let ready = false;
  while (Date.now() < deadline) {
    try { ready = (await fetch('http://127.0.0.1:3002/health/ready', { signal: AbortSignal.timeout(2000) })).status === 200; } catch { ready = false; }
    if (ready) break; await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!ready) { await cleanupTest(); throw new Error('Messaging worker did not become ready after the isolated migration'); }
  return cleanupTest;
  async function cleanupTest() {
    const cleanup = createMongoClient(config);
    try {
      await cleanup.connect(); await cleanup.db(name).dropDatabase();
      // Remove the schema marker before queue cleanup, so the still-draining worker cannot redeclare it.
      const broker = await BrokerTransport.open(config);
      try { await broker.deleteTestTopology(); } finally { await broker.close(); }
    } finally { await cleanup.close(); }
  }
}
