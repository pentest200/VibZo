import { loadConfig } from '@chat/config';
import { createLogger } from '@chat/observability';
import { createApi } from './app.js';
const config = loadConfig();
const logger = createLogger('api', config.LOG_LEVEL);
const { app, close } = await createApi(config);
await app.listen(config.API_PORT, config.HOST);
logger.info({ port: config.API_PORT }, 'foundation API listening');
let draining = false;
const stop = async () => {
  if (draining) return;
  draining = true;
  const deadline = setTimeout(() => process.exit(1), 10000).unref();
  await close(); clearTimeout(deadline); logger.info('API drained');
};
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
