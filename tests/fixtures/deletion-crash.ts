import { loadConfig } from '@chat/config';
import { AuthService, SafetyMaintenance, SafetyService, createMongoClient } from '@chat/domain';
const config = loadConfig();
if (config.NODE_ENV !== 'test' || !config.MONGODB_DATABASE.startsWith('safety_test_')) throw new Error('An isolated safety test database is required');
const client = createMongoClient(config); await client.connect();
const service = new SafetyService(new AuthService(config, client, client.db(config.MONGODB_DATABASE)));
try { await new SafetyMaintenance(service, async () => { process.exit(86); }).deletionOnce(); }
finally { await client.close(); }
