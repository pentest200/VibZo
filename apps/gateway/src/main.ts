import { loadConfig } from '@chat/config';
import { createGateway } from './app.js';
import { startTelemetry } from '@chat/observability';
import { setTimeout as delay } from 'node:timers/promises';
const config = loadConfig(), telemetry = startTelemetry('gateway', config);
const gateway = await createGateway(config);
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; const deadline = setTimeout(() => process.exit(1), config.DRAIN_TIMEOUT_MS + config.DRAIN_DELAY_MS + 2500).unref(); gateway.beginDrain(); await delay(config.DRAIN_DELAY_MS); await gateway.close(); await telemetry.close(); clearTimeout(deadline); };
process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
