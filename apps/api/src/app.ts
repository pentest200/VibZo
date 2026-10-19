import 'reflect-metadata';
import { Controller, Get, Inject, Module, Res, HttpException } from '@nestjs/common';
import type { ExceptionFilter, ArgumentsHost } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { defer, finalize } from 'rxjs';
import cookie from '@fastify/cookie';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Config } from '@chat/config';
import { AuthService, AttachmentService, AvatarService, ConversationService, MessageService, SyncService, SafetyService, CallService, DomainError, createMongoClient, inspectMongo, mongoPoolMetrics, recoveryReady } from '@chat/domain';
import { createMetrics, createLogger, httpMetrics, beginRequestSpan, DrainTracker, operationalMetrics } from '@chat/observability';
import { AUTH, AuthController, sessionCookieName } from './auth.js';
import { CONVERSATIONS, ConversationController } from './conversations.js';
import { MESSAGES, MessageController } from './messages.js';
import { ATTACHMENTS, AttachmentController } from './attachments.js';
import { AVATARS, AvatarController } from './avatars.js';
import { SYNC, SyncController } from './sync.js';
import { SAFETY, SafetyController } from './safety.js';
import { CALLS, CallController, CallWebhookController } from './calls.js';

interface Reply { code(status: number): Reply; type(contentType: string): Reply }
interface Health { dependencies(): Promise<{ mongodb: 'up' | 'down' }>; recovery(): Promise<boolean>; metrics: ReturnType<typeof createMetrics>; draining(): boolean; poolMetrics(): string }
const HEALTH = 'FOUNDATION_HEALTH';

@Controller()
class FoundationController {
  constructor(@Inject(HEALTH) private readonly health: Health) {}
  @Get('/health/live') live() { return { status: 'alive', service: 'api' }; }
  @Get('/health/dependencies') dependencies() { return this.health.dependencies(); }
  @Get('/health/ready') async ready(@Res({ passthrough: true }) reply: Reply) {
    const dependencies = await this.health.dependencies();
    const ready = !this.health.draining() && dependencies.mongodb === 'up' && await this.health.recovery();
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'unavailable', service: 'api', phase: 'foundation', dependencies };
  }
  @Get('/metrics') async metrics(@Res({ passthrough: true }) reply: Reply) {
    reply.type(this.health.metrics.contentType);
    return await this.health.metrics.metrics() + this.health.poolMetrics() + await operationalMetrics();
  }
}

@Module({})
class FoundationModule {}

export async function createApi(config: Config) {
  const client = createMongoClient(config);
  const metrics = createMetrics();
  const http = httpMetrics(metrics), handlers = new DrainTracker(); let draining = false, closing: Promise<void> | undefined;
  const beginDrain = () => { draining = true; http.draining.set(1); };
  const logger = createLogger('api', config.LOG_LEVEL);
  const auth = new AuthService(config, client, client.db(config.MONGODB_DATABASE));
  await auth.initialize();
  const attachments = new AttachmentService(auth);
  const avatars = new AvatarService(auth);
  const health: Health = { dependencies: async () => ({ mongodb: await inspectMongo(client) ? 'up' : 'down' }), recovery: () => recoveryReady(auth.db).catch(() => false), metrics, draining: () => draining, poolMetrics: () => mongoPoolMetrics(client) };
  const adapter = new FastifyAdapter({ bodyLimit: 65536, requestTimeout: 10000, trustProxy: false, logger: false, genReqId: () => randomUUID() });
  const app = await NestFactory.create<NestFastifyApplication>({
    module: FoundationModule, controllers: [FoundationController, AuthController, ConversationController, MessageController, SyncController, AttachmentController, AvatarController, SafetyController, CallController, CallWebhookController], providers: [{ provide: AVATARS, useValue: avatars }, { provide: CALLS, useValue: new CallService(auth) }, { provide: SAFETY, useValue: new SafetyService(auth) }, { provide: ATTACHMENTS, useValue: attachments }, { provide: HEALTH, useValue: health }, { provide: AUTH, useValue: auth }, { provide:CONVERSATIONS,useValue:new ConversationService(auth) }, { provide:MESSAGES,useValue:new MessageService(auth) }, { provide:SYNC,useValue:new SyncService(auth) }]
  }, adapter, { logger: false, rawBody: true });
  app.setGlobalPrefix('api/v1', { exclude: ['health/live', 'health/ready', 'health/dependencies', 'metrics'] });
  await adapter.getInstance().register(cookie);
  const requests = new WeakMap<FastifyRequest, { start: number; method: string; route: string; span: ReturnType<typeof beginRequestSpan> }>();
  const finish = (request: FastifyRequest, status: number) => {
    const state = requests.get(request); if (!state) return;
    requests.delete(request); http.active.dec();
    http.duration.observe({ method: state.method, route: state.route, status: String(status) }, (performance.now() - state.start) / 1000);
    state.span.setAttribute('http.response.status_code', status);
    if (status >= 500) state.span.setStatus({ code: 2 });
    state.span.end();
    logger.info({ requestId: request.id, method: state.method, route: state.route, status }, 'request completed');
  };
  adapter.getInstance().addHook('onRequest', (request, reply, done) => {
    const route = request.routeOptions.url ?? 'unmatched';
    const method = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].includes(request.method) ? request.method : 'OTHER';
    reply.header('X-Request-Id', request.id); http.active.inc();
    const state = { start: performance.now(), method, route, span: undefined as unknown as ReturnType<typeof beginRequestSpan> };
    requests.set(request, state);
    state.span = beginRequestSpan(method, route, done);
    reply.raw.once('close', () => { if (!reply.raw.writableFinished) finish(request, 499); });
  });
  adapter.getInstance().addHook('onResponse', async (request, reply) => {
    finish(request, reply.statusCode);
  });
  adapter.getInstance().addHook('onRequestAbort', async request => {
    finish(request, 499);
  });
  adapter.getInstance().addContentTypeParser('application/webhook+json', { parseAs: 'buffer' }, (_request, body, done) => done(null, body));
  const protectedMutation = new Set(['/api/v1/auth/logout', '/api/v1/auth/password', '/api/v1/auth/verify/request', '/api/v1/me']);
  adapter.getInstance().addHook('preHandler', async (request, reply) => handlers.run(async () => {
    if (!request.routeOptions.url?.startsWith('/api/v1/')) return;
    if (!await recoveryReady(auth.db)) throw new DomainError('UNAVAILABLE', 'Recovery verification is incomplete.', 503, true);
    if (draining) { http.rejected.inc(); reply.header('Retry-After', '1'); throw new DomainError('UNAVAILABLE', 'Service is draining. Retry shortly.', 503, true); }
    reply.header('X-Request-Id', request.id);
    if (request.routeOptions.url === '/api/v1/webhooks/livekit') return; // Exact raw-body provider JWT verification replaces browser Origin/CSRF here only.
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
      const avatarRead = /^\/api\/v1\/avatars\/[^/]+\/download$/.test(path);
      await auth.rates.consume(`${avatarRead ? 'avatar-download' : ephemeral ? 'snapshot' : 'mutation'}-ip:${request.ip}`, avatarRead ? config.AVATAR_DOWNLOAD_RATE_LIMIT : ephemeral ? 240 : config.AUTH_RATE_LIMIT);
      if (protectedMutation.has(path) || path.startsWith('/api/v1/avatars') || path.startsWith('/api/v1/calls') || path.startsWith('/api/v1/safety') || path.startsWith('/api/v1/sessions') || path.startsWith('/api/v1/conversations') || path.startsWith('/api/v1/blocks') || path.startsWith('/api/v1/attachments') || path.startsWith('/api/v1/messages') || path.startsWith('/api/v1/sync')) {
        const raw = request.cookies[sessionCookieName(config.COOKIE_SECURE)];
        await auth.authenticate(raw);
        auth.assertCsrf(raw, typeof request.headers['x-csrf-token'] === 'string' ? request.headers['x-csrf-token'] : undefined);
      }
    }
  }));
  const filter: ExceptionFilter = {
    catch(error: unknown, host: ArgumentsHost) {
      const reply = host.switchToHttp().getResponse<FastifyReply>();
      const requestId = host.switchToHttp().getRequest<FastifyRequest>().id;
      const domain = error instanceof DomainError ? error : null;
      const status = domain?.status ?? (error instanceof HttpException ? error.getStatus() : typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : 503);
      if (!domain) logger.warn({ requestId, code: status >= 500 ? 'DEPENDENCY_UNAVAILABLE' : 'INVALID_REQUEST' }, 'request failed');
      reply.code(status).send({ code: domain?.code ?? (status >= 500 ? 'UNAVAILABLE' : 'INVALID_INPUT'), message: domain?.message ?? 'The request could not be completed.', requestId, retryable: domain?.retryable ?? status >= 500 });
    }
  };
  app.useGlobalFilters(filter);
  app.useGlobalInterceptors({ intercept: (_context, next) => defer(() => {
    handlers.active++;
    return next.handle().pipe(finalize(() => { handlers.active--; }));
  }) });
  adapter.getInstance().addHook('onSend', async (_request, reply, payload) => {
    // A response finishing after server.close() must not enter a fresh keep-alive
    // interval (72s by default). Let accepted handlers finish, then close HTTP/1.
    if (draining && _request.raw.httpVersionMajor === 1) reply.header('Connection', 'close');
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    return payload;
  });
  await app.init();
  const close = () => closing ??= (async () => { beginDrain(); await app.close(); await handlers.idle(config.DRAIN_TIMEOUT_MS); attachments.close(); avatars.close(); await auth.close(); await client.close(); metrics.clear(); })();
  return { app, beginDrain, close };
}
