import { loadConfig } from '@chat/config';
import { createMongoClient, runMigrations } from '@chat/domain';
const config = loadConfig(); const client = createMongoClient(config);
try { await client.connect(); await runMigrations(client.db(config.MONGODB_DATABASE)); console.log('001_auth through 011_chat_interactions migrations applied'); }
finally { await client.close(); }
