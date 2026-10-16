import 'reflect-metadata';
import { Controller, Get, Inject, Module, Res, HttpException } from '@nestjs/common';
import type { ExceptionFilter, ArgumentsHost } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyReply } from 'fastify';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Config } from '@chat/config';
import { AuthService, ConversationService, MessageService, SyncService, DomainError, createMongoClient, inspectMongo } from '@chat/domain';
import { createMetrics, createLogger } from '@chat/observability';
import { AUTH, AuthController, sessionCookieName } from './auth.js';
import { CONVERSATIONS, ConversationController } from './conversations.js';
import { MESSAGES, MessageController } from './messages.js';
import { SYNC, SyncController } from './sync.js';

interface Reply { code(status: number): Reply; type(contentType: string): Reply }
interface Health { dependencies(): Promise<{ mongodb: 'up' | 'down' }>; metrics: ReturnType<typeof createMetrics> }
const HEALTH = 'FOUNDATION_HEALTH';

@Controller()
class FoundationController {
  constructor(@Inject(HEALTH) private readonly health: Health) {}
  @Get('/health/live') live() { return { status: 'alive', service: 'api' }; }
  @Get('/health/dependencies') dependencies() { return this.health.dependencies(); }
  @Get('/health/ready') async ready(@Res({ passthrough: true }) reply: Reply) {
    const dependencies = await this.health.dependencies();
    const ready = dependencies.mongodb === 'up';
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'unavailable', service: 'api', phase: 'foundation', dependencies };
  }
  @Get('/metrics') async metrics(@Res({ passthrough: true }) reply: Reply) {
    reply.type(this.health.metrics.contentType);
    return this.health.metrics.metrics();
  }
}

@Module({})
class FoundationModule {}

export async function createApi(config: Config): Promise<{ app: NestFastifyApplication; close: () => Promise<void> }> {
  const client = createMongoClient(config);
  const metrics = createMetrics();
  const logger = createLogger('api', config.LOG_LEVEL);
  const auth = new AuthService(config, client, client.db(config.MONGODB_DATABASE));
  await auth.initialize();
  const health: Health = { dependencies: async () => ({ mongodb: await inspectMongo(client) ? 'up' : 'down' }), metrics };
  const adapter = new FastifyAdapter({ bodyLimit: 65536, requestTimeout: 10000, trustProxy: false, logger: false, genReqId: () => randomUUID() });
  const app = await NestFactory.create<NestFastifyApplication>({
    module: FoundationModule, controllers: [FoundationController, AuthController, ConversationController, MessageController, SyncController], providers: [{ provide: HEALTH, useValue: health }, { provide: AUTH, useValue: auth }, { provide:CONVERSATIONS,useValue:new ConversationService(auth) }, { provide:MESSAGES,useValue:new MessageService(auth) }, { provide:SYNC,useValue:new SyncService(auth) }]
  }, adapter, { logger: false });
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready', 'health/dependencies', 'metrics'] });
  await adapter.getInstance().register(cookie);
  const protectedMutation = new Set(['/api/v1/auth/logout', '/api/v1/auth/password', '/api/v1/auth/verify/request', '/api/v1/me']);
  adapter.getInstance().addHook('preHandler', async (request, reply) => {
    if (!request.routeOptions.url?.startsWith('/api/v1/')) return;
    reply.header('X-Request-Id', request.id);
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(request.method);
    if (mutation) {
      if (request.headers.origin !== config.WEB_ORIGIN) throw new DomainError('FORBIDDEN', 'This request is not allowed.', 403);
      if (request.method !== 'DELETE' && !/^application\/json(?:;|$)/i.test(request.headers['content-type'] ?? '')) throw new DomainError('INVALID_INPUT', 'Send a JSON request.', 415);
    }
    await auth.assertSchema();
    if (mutation) {
      const path = request.url.split('?')[0] ?? '';
      // Ephemeral snapshot churn has its own bounded budget; it cannot starve accepted message commands.
      const ephemeral = path.startsWith('/api/v1/sync/snapshots');
      await auth.rates.consume(`${ephemeral ? 'snapshot' : 'mutation'}-ip:${request.ip}`, ephemeral ? 240 : config.AUTH_RATE_LIMIT);
      if (protectedMutation.has(path) || path.startsWith('/api/v1/sessions') || path.startsWith('/api/v1/conversations') || path.startsWith('/api/v1/blocks') || path.startsWith('/api/v1/messages') || path.startsWith('/api/v1/sync')) {
        const raw = request.cookies[sessionCookieName(config.COOKIE_SECURE)];
        await auth.authenticate(raw);
        auth.assertCsrf(raw, typeof request.headers['x-csrf-token'] === 'string' ? request.headers['x-csrf-token'] : undefined);
      }
    }
  });
  const filter: ExceptionFilter = {
    catch(error: unknown, host: ArgumentsHost) {
      const reply = host.switchToHttp().getResponse<FastifyReply>();
      const requestId = randomUUID();
      const domain = error instanceof DomainError ? error : null;
      const status = domain?.status ?? (error instanceof HttpException ? error.getStatus() : typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 503);
      if (!domain) logger.warn({ requestId, code: status >= 500 ? 'DEPENDENCY_UNAVAILABLE' : 'INVALID_REQUEST' }, 'request failed');
      reply.code(status).send({ code: domain?.code ?? (status >= 500 ? 'UNAVAILABLE' : 'INVALID_INPUT'), message: domain?.message ?? 'The request could not be completed.', requestId, retryable: domain?.retryable ?? status >= 500 });
    }
  };
  app.useGlobalFilters(filter);
  adapter.getInstance().addHook('onSend', async (_request, reply, payload) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });
  await app.init();
  const close = async () => { await app.close(); await auth.close(); await client.close(); metrics.clear(); };
  return { app, close };
}
