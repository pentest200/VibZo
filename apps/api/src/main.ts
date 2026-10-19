import { loadConfig } from '@chat/config';
import { setTimeout as delay } from 'node:timers/promises';
import { createLogger, startTelemetry } from '@chat/observability';
import { createApi } from './app.js';
const config = loadConfig();
const logger = createLogger('api', config.LOG_LEVEL);
const telemetry = startTelemetry('api', config);
const { app, close, beginDrain } = await createApi(config);
await app.listen(config.API_PORT, config.HOST);
logger.info({ port: config.API_PORT }, 'foundation API listening');
let draining = false;
const stop = async () => {
  if (draining) return;
  draining = true;
  const deadline = setTimeout(() => process.exit(1), config.DRAIN_TIMEOUT_MS + config.DRAIN_DELAY_MS + 2500).unref();
  beginDrain(); await delay(config.DRAIN_DELAY_MS); await close(); await telemetry.close(); clearTimeout(deadline); logger.info('API drained');
};
process.once('SIGTERM', () => { void stop(); });
process.once('SIGINT', () => { void stop(); });
