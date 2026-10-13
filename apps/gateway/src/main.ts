import { loadConfig } from '@chat/config';
import { startFoundationProcess } from '@chat/observability';
const config = loadConfig();
await startFoundationProcess('gateway', config.HOST, config.GATEWAY_PORT, config.LOG_LEVEL);
