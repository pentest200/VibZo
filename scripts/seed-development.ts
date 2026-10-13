import { loadConfig } from '@chat/config';
import { AuthService, createMongoClient, migrateAuth } from '@chat/domain';
import { registerSchema } from '@chat/contracts';
const config = loadConfig();
if (config.NODE_ENV !== 'development') throw new Error('Seed is development-only');
const password = process.env['SEED_PASSWORD'];
if (!password) throw new Error('Provide SEED_PASSWORD in the process environment; no default password is generated');
const client = createMongoClient(config); const auth = new AuthService(config, client, client.db(config.MONGODB_DATABASE));
try {
  await client.connect(); await migrateAuth(auth.db); await auth.initialize();
  for (const username of ['alice_dev','bob_dev']) {
    await auth.register(registerSchema.parse({ email: `${username}@example.test`, username, displayName: username === 'alice_dev' ? 'Alice (development)' : 'Bob (development)', password }));
  }
  console.log('Development fixture registration completed. Start worker and verify emails through Mailpit; no privileged accounts created.');
} finally { await auth.close(); await client.close(); }
