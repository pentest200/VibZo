import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApi } from '@chat/api';
import { loadConfig } from '@chat/config';
import { readinessSchema } from '@chat/contracts';

// Real HTTP/Nest/Fastify with an intentionally unreachable database; no mocked readiness.
let server: Awaited<ReturnType<typeof createApi>>;
let origin: string;
beforeAll(async () => {
  server = await createApi(loadConfig({ NODE_ENV: 'test', MONGODB_URI: 'mongodb://127.0.0.1:1/?replicaSet=unavailable&directConnection=true', DEPENDENCY_TIMEOUT_MS: '100' }));
  await server.app.listen(0, '127.0.0.1');
  origin = await server.app.getUrl();
});
afterAll(async () => { if (server) await server.close(); });
it('keeps liveness available during dependency failure', async () => {
  const response = await fetch(`${origin}/health/live`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ status: 'alive', service: 'api' });
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
});
it('returns honest 503 readiness, with safe runtime-validated fields', async () => {
  const response = await fetch(`${origin}/health/ready`);
  expect(response.status).toBe(503);
  const body = readinessSchema.parse(await response.json());
  expect(body.status).toBe('unavailable');
  expect(body.dependencies.mongodb).toBe('down');
  expect(JSON.stringify(body)).not.toContain('mongodb://');
});
it('serves process metrics and no placeholder feature routes', async () => {
  const response = await fetch(`${origin}/metrics`);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('chat_process_cpu');
  const missing = await fetch(`${origin}/api/v1/not-implemented`);
  expect(missing.status).toBe(404);
});
