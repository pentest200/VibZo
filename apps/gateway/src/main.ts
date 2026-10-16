import { loadConfig } from '@chat/config';
import { createGateway } from './app.js';
const gateway = await createGateway(loadConfig());
let stopping = false;
const stop = async () => { if (stopping) return; stopping = true; const deadline = setTimeout(() => process.exit(1), 10000).unref(); await gateway.close(); clearTimeout(deadline); };
process.once('SIGTERM', () => { void stop(); }); process.once('SIGINT', () => { void stop(); });
