import { loadConfig } from '@chat/config';
import { AttachmentService, AttachmentWorker, AuthService, createMongoClient } from '@chat/domain';
const config = loadConfig();
if (config.NODE_ENV !== 'test' || !config.MONGODB_DATABASE.startsWith('attachments_test_')) throw new Error('Crash harness requires isolated attachment database');
const client = createMongoClient(config); await client.connect();
const service = new AttachmentService(new AuthService(config, client, client.db(config.MONGODB_DATABASE)));
// Actual exit after private approved PUT, before Mongo ready/lease commit.
await new AttachmentWorker(service, async () => { process.exit(73); }).runOnce();
throw new Error('No crash candidate');
