import { loadConfig } from '@chat/config';
import { startFoundationProcess, createLogger } from '@chat/observability';
import { createMongoClient, AuthEmailWorker, authSchemaReady } from '@chat/domain';
const config = loadConfig();
const server = await startFoundationProcess('worker', config.HOST, config.WORKER_PORT, config.LOG_LEVEL);
const client = createMongoClient(config); const db = client.db(config.MONGODB_DATABASE);
const worker = new AuthEmailWorker(db, config); const logger = createLogger('auth-email-worker', config.LOG_LEVEL);
let stopped = false;
const stop = () => { stopped = true; server.close(); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
try {
  while (!stopped) {
    try { if (await authSchemaReady(db)) await worker.runOnce(); }
    catch { logger.warn({ code: 'DEPENDENCY_UNAVAILABLE' }, 'email processing delayed'); }
    if (!stopped) await new Promise(resolve => setTimeout(resolve, 1000));
  }
} finally { await client.close(); }
