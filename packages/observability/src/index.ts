import { pino } from 'pino';
import { collectDefaultMetrics, Registry } from '@prometheus-io/client';
import { trace } from '@opentelemetry/api';
import { createServer } from 'node:http';

export function createLogger(service: string, level = 'info', destination?: Parameters<typeof pino>[1]) {
  return pino({
    level, base: { service },
    // Log identifiers/classification, never whole transport or provider errors.
    redact: { paths: ['password', 'token', 'secret', 'body', 'text', 'url', 'cookie', 'authorization', '*.password', '*.token', '*.secret', '*.body', '*.text', '*.url', 'req.headers', 'res.headers', '*.credentials', '*.passwordHash', '*.sessionToken'], censor: '[REDACTED]' }
  }, destination);
}
export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: 'chat_' });
  return registry;
}
export const tracer = trace.getTracer('chat-application', '0.0.0');

// Foundation processes expose liveness but refuse readiness until their functional phase.
export async function startFoundationProcess(service: 'gateway' | 'worker', host: string, port: number, level: string) {
  const logger = createLogger(service, level);
  const metrics = createMetrics();
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.method === 'GET' && request.url === '/metrics') {
      response.setHeader('Content-Type', metrics.contentType);
      response.end(await metrics.metrics());
      return;
    }
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET' && request.url === '/health/live') response.end(JSON.stringify({ status: 'alive', service }));
    else if (request.method === 'GET' && request.url === '/health/ready') {
      response.statusCode = 503;
      response.end(JSON.stringify({ status: 'unavailable', service, phase: 'foundation' }));
    } else { response.statusCode = 404; response.end(JSON.stringify({ code: 'NOT_FOUND' })); }
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  logger.info({ port }, 'foundation process listening');
  const stop = () => { server.close(() => { metrics.clear(); logger.info('process drained'); }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return server;
}
