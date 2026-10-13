import { loadConfig } from '@chat/config';
import { createMongoClient, migrateAuth } from '@chat/domain';
const config = loadConfig(); const client = createMongoClient(config);
try { await client.connect(); await migrateAuth(client.db(config.MONGODB_DATABASE)); console.log('001_auth migration applied'); }
finally { await client.close(); }
