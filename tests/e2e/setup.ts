import { loadConfig } from '@chat/config';
import { createMongoClient, migrateAuth } from '@chat/domain';
export default async function setup() {
  const name = process.env['E2E_DATABASE'];
  if (!name?.startsWith('chat_e2e_auth_')) throw new Error('E2E requires an isolated auth test database');
  const config = loadConfig({ ...process.env, MONGODB_DATABASE: name });
  const client = createMongoClient(config);
  try { await client.connect(); await migrateAuth(client.db(name)); } finally { await client.close(); }
  return async () => {
    const cleanup = createMongoClient(config);
    try { await cleanup.connect(); await cleanup.db(name).dropDatabase(); } finally { await cleanup.close(); }
  };
}
