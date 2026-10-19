import { loadConfig } from '@chat/config';
import { snapshotAgent, telemetryDirectory } from './telemetry-runtime.js';
const shutdown = new AbortController();
process.once('SIGTERM', () => shutdown.abort()); process.once('SIGINT', () => shutdown.abort());
try { await snapshotAgent(loadConfig(), await telemetryDirectory(), shutdown.signal); }
catch { console.error('Local telemetry agent unavailable; check role/dependency configuration and agent lock.'); process.exitCode = 1; }
