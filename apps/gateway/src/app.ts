import { createServer } from 'node:http';
import { Server } from 'socket.io';
import type { Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { socketAuthSchema, subscriptionSchema, typingSchema, presenceQuerySchema } from '@chat/contracts';
import type { BrokerEvent, LiveHint } from '@chat/contracts';
import type { Config } from '@chat/config';
import { AuthService, SyncService, createMongoClient, inspectMongo, mongoPoolMetrics, syncSchemaReady, syncChannel, parseFanout, DomainError } from '@chat/domain';
import type { ControlEvent, UserRecord } from '@chat/domain';
import { createMetrics, DrainTracker, traced, operationalMetrics } from '@chat/observability';

interface ClientData { token: string; userId: string; sessionId: string; selectedId?: string; pending: number; commands: number; checking: boolean; inboxWatermark?: string }
type Client = Socket<Record<string, (...args: unknown[]) => void>, Record<string, (...args: unknown[]) => void>, Record<string, (...args: unknown[]) => void>, ClientData>;
const cookieToken = (cookie: string | undefined, secure: boolean) => cookie?.split(';').map(item => item.trim()).find(item => item.startsWith(`${secure ? '__Host-' : ''}commonroom_session=`))?.split('=')[1];
const quotaScript = `local t=redis.call('TIME'); local now=t[1]*1000+math.floor(t[2]/1000); redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now); if ARGV[3]=='renew' and not redis.call('ZSCORE',KEYS[1],ARGV[1]) then return 0 end; if ARGV[3]=='new' and redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) then return 0 end; redis.call('ZADD',KEYS[1],now+60000,ARGV[1]); redis.call('PEXPIRE',KEYS[1],60000); return 1`;
const presenceScript = `local t=redis.call('TIME');local now=t[1]*1000+math.floor(t[2]/1000);redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now);if ARGV[1]=='ping' then redis.call('ZADD',KEYS[1],now+30000,ARGV[2]);redis.call('PEXPIRE',KEYS[1],30000) end;return redis.call('ZCARD',KEYS[1])`;
export async function createGateway(config: Config, port = config.GATEWAY_PORT) {
  const mongo = createMongoClient(config), auth = new AuthService(config, mongo, mongo.db(config.MONGODB_DATABASE)), service = new SyncService(auth), metrics = createMetrics();
  const options = { url: config.REDIS_URL, disableOfflineQueue: true, commandsQueueMaxLength: 1024, socket: { connectTimeout: config.DEPENDENCY_TIMEOUT_MS, reconnectStrategy: (attempt: number) => Math.min(3000, 100 * 2 ** Math.min(5, attempt)) } };
  const pub = createClient(options), sub = pub.duplicate(), hints = pub.duplicate(), prefix = syncChannel(config);
  for (const redis of [pub, sub, hints]) redis.on('error', () => {});
  const work = new DrainTracker(); let closePromise: Promise<void> | undefined;
  let closing = false, handshakes = 0; const lifecycle: { interval?: ReturnType<typeof setInterval> } = {};
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    if (request.url === '/metrics') { response.setHeader('Content-Type', metrics.contentType); response.end(`${await metrics.metrics()}${await operationalMetrics()}${mongoPoolMetrics(mongo)}chat_process_draining ${closing ? 1 : 0}\nchat_gateway_inflight ${work.active}\nchat_gateway_connections ${clients().length}\nchat_gateway_hint_queue ${queue.length}\nchat_gateway_pending_acks ${clients().reduce((sum, socket) => sum + socket.data.pending, 0)}\n`); return; }
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/health/live') { response.end(JSON.stringify({ status: 'alive', service: 'gateway' })); return; }
    if (request.url === '/health/ready') {
      const ready = !closing && pub.isReady && sub.isReady && hints.isReady && await inspectMongo(mongo) && await syncSchemaReady(service.db).catch(() => false);
      response.statusCode = ready ? 200 : 503; response.end(JSON.stringify({ status: ready ? 'ready' : 'unavailable', phase: 'sync', service: 'gateway' })); return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ code: 'NOT_FOUND' }));
  });
  const io = new Server(server, { transports: ['websocket'], maxHttpBufferSize: config.MAX_SOCKET_BYTES, serveClient: false, pingInterval: 10000, pingTimeout: 10000,
    allowRequest: (request, accept) => accept(null, !closing && request.headers.origin === config.WEB_ORIGIN), cors: { origin: config.WEB_ORIGIN, credentials: true } });
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Dependency deadline')), 3000); })]); }
    finally { if (timer) clearTimeout(timer); }
  };
  const begin = (socket: Client) => { if (closing || socket.data.commands >= 4) return false; socket.data.commands++; return true; };
  const end = (socket: Client) => { socket.data.commands = Math.max(0, socket.data.commands - 1); };
  const clients = () => [...io.sockets.sockets.values()] as unknown as Client[];
  const quotaKey = (sessionId: string) => `${prefix}:connections:${sessionId}`;
  async function identity(socket: Client) { if (!pub.isReady || !sub.isReady) throw new Error('Redis unavailable'); return service.run(session => service.actor(socket.data.token, session)); }
  function emitHint(socket: Client, hint: LiveHint) {
    if (socket.data.pending >= config.MAX_LIVE_BUFFER_EVENTS) { socket.disconnect(true); return; }
    socket.data.pending++;
    socket.timeout(5000).emit('sync:hint', hint, (error: Error | null) => { socket.data.pending = Math.max(0, socket.data.pending - 1); if (error) socket.disconnect(true); });
  }
  async function dispatch(reference: BrokerEvent) {
    const row = await service.db.collection<{ _id: string; traceparent?: string }>('outbox').findOne({ _id: reference.eventId }, { projection: { traceparent: 1 } });
    return traced('gateway.dispatch', {}, async () => {
      const canonical = await service.db.collection<ControlEvent>('conversationEvents').findOne({ _id: reference.eventId, conversationId: reference.conversationId }); if (!canonical || canonical.sequence.toString() !== reference.sequence || canonical.kind !== reference.kind) return;
      for (const socket of clients()) {
        try {
          const principal = await identity(socket), member = await service.members().findOne({ conversationId: reference.conversationId, userId: principal.user._id });
          const invited = member?.state === 'invited' && !!member.invitationExpiresAt && member.invitationExpiresAt > new Date();
          if (member?.state === 'active' || invited || canonical.payload['targetUserId'] === principal.user._id) {
            if (member?.state === 'active' && socket.data.selectedId === reference.conversationId) { await service.detail(socket.data.token, reference.conversationId); emitHint(socket, { kind: 'conversation', conversationId: reference.conversationId }); }
            else { if (socket.data.selectedId === reference.conversationId) delete socket.data.selectedId; emitHint(socket, { kind: 'inbox' }); }
          }
        } catch { socket.disconnect(true); }
      }
    }, row?.traceparent);
  }
  const queue: BrokerEvent[] = []; let pumping = false;
  function enqueue(reference: BrokerEvent) {
    if (closing) return;
    if (queue.length >= config.MAX_LIVE_BUFFER_EVENTS) { queue.length = 0; for (const socket of clients()) socket.disconnect(true); return; }
    queue.push(reference); if (pumping) return; pumping = true;
    void work.run(async () => { try { while (queue.length && !closing) { const next = queue.shift(); if (next) await dispatch(next); } } finally { pumping = false; } }).catch(() => {});
  }
  try {
    await mongo.connect(); await auth.initialize(); await bounded(Promise.all([pub.connect(), sub.connect(), hints.connect()]));
    io.adapter(createAdapter(pub, sub, { key: `${prefix}:adapter`, publishOnSpecificResponseChannel: true }));
    io.on('durable:hint', (raw: unknown) => { const reference = parseFanout(JSON.stringify(raw)); if (reference) enqueue(reference); });
    await hints.subscribe(prefix, raw => {
      if (closing) return;
      const reference = parseFanout(raw); if (!reference) return;
      void work.run(() => bounded(pub.withCommandOptions({ timeout: config.DEPENDENCY_TIMEOUT_MS }).set(`${prefix}:dispatch:${reference.eventId}`, '1', { NX: true, EX: 5 }))).then(won => {
        if (won) { io.serverSideEmit('durable:hint', reference); enqueue(reference); }
      }).catch(() => {});
    });
    await hints.subscribe('auth.revoked.v1', raw => {
      if (closing) return;
      try { const hint = JSON.parse(raw) as { userId?: string }; for (const socket of clients()) if (socket.data.userId === hint.userId) void work.run(() => identity(socket)).catch(() => socket.disconnect(true)); } catch { /* discard malformed reference */ }
    });
    io.use((rawSocket, next) => { const socket = rawSocket as unknown as Client;
      if (handshakes >= 32) { next(new Error('Gateway busy.')); return; } handshakes++;
      void work.run(async () => {
        if (closing || io.engine.clientsCount > 1000) throw new Error('Gateway unavailable');
        const parsed = socketAuthSchema.safeParse(socket.handshake.auth); if (!parsed.success) throw new Error('Invalid authentication');
        const token = cookieToken(socket.handshake.headers.cookie, config.COOKIE_SECURE); auth.assertCsrf(token, parsed.data.csrf);
        const principal = await service.run(session => service.actor(token, session));
        const allowed = await bounded(pub.withCommandOptions({ timeout: config.DEPENDENCY_TIMEOUT_MS }).eval(quotaScript, { keys: [quotaKey(principal.session._id)], arguments: [socket.id, String(config.MAX_CONNECTIONS_PER_SESSION), 'new'] }));
        if (allowed !== 1) throw new Error('Connection limit reached');
        socket.data = { token: token!, userId: principal.user._id, sessionId: principal.session._id, pending: 0, commands: 0, checking: false }; next();
      }).catch(() => next(new Error('Connection not authorized or temporarily unavailable.'))).finally(() => { handshakes--; });
    });
    io.on('connection', rawSocket => { const socket = rawSocket as unknown as Client;
      socket.on('sync:subscribe', (raw: unknown, callback: unknown) => {
        if (typeof callback !== 'function') return;
        if (!begin(socket)) { callback({ ok: false }); return; }
        void work.run(async () => {
          const parsed = subscriptionSchema.safeParse(raw); if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Invalid subscription.', 400);
          await auth.rates.consume(`subscribe:${socket.data.sessionId}`); await identity(socket); const detail = await service.detail(socket.data.token, parsed.data.conversationId);
          socket.data.selectedId = detail.id; callback({ ok: true, watermark: detail.watermark });
        }).catch(() => callback({ ok: false })).finally(() => end(socket));
      });
      socket.on('sync:typing', (raw: unknown) => {
        const parsed = typingSchema.safeParse(raw); if (!parsed.success || !begin(socket)) return;
        void work.run(async () => {
          await auth.rates.consume(`typing:${socket.data.sessionId}`); await identity(socket);
          await service.authorizedOperation(socket.data.token, parsed.data.conversationId, async () => true);
          // Fanout is reauthorized on each receiving gateway; no client body/identity claim is forwarded.
          const packet = { conversationId: parsed.data.conversationId, userId: socket.data.userId, active: parsed.data.active };
          io.serverSideEmit('ephemeral:typing', packet); await typing(packet);
        }).catch(() => {}).finally(() => end(socket));
      });
      socket.on('sync:presence', (raw: unknown, callback: unknown) => {
        if (typeof callback !== 'function') return; const parsed = presenceQuerySchema.safeParse(raw); if (!parsed.success || !begin(socket)) { callback({ ok: false }); return; }
        void work.run(async () => {
          await auth.rates.consume(`presence:${socket.data.sessionId}`); await identity(socket);
          const visible = await service.run(async session => {
            await service.authorize(socket.data.token, parsed.data.conversationId, session);
            await service.guardPair(socket.data.userId, parsed.data.targetUserId, session);
            if (!await service.members().findOne({ conversationId: parsed.data.conversationId, userId: parsed.data.targetUserId, state: 'active' }, { session })) return false;
            return !!await service.db.collection<UserRecord>('users').findOne({ _id: parsed.data.targetUserId, 'privacy.showPresence': true }, { session });
          });
          callback({ ok: true, online: visible ? Number(await bounded(pub.withCommandOptions({ timeout: config.DEPENDENCY_TIMEOUT_MS }).eval(presenceScript, { keys: [`${prefix}:presence:${parsed.data.targetUserId}`], arguments: ['read', ''] }))) > 0 : null });
        }).catch(() => callback({ ok: false })).finally(() => end(socket));
      });
      socket.on('disconnect', () => { void work.run(() => bounded(Promise.all([pub.withCommandOptions({ timeout: config.DEPENDENCY_TIMEOUT_MS }).zRem(quotaKey(socket.data.sessionId), socket.id), pub.withCommandOptions({ timeout: config.DEPENDENCY_TIMEOUT_MS }).zRem(`${prefix}:presence:${socket.data.userId}`, socket.id)]))).catch(() => {}); });
    });
    async function typing(packet: { conversationId: string; userId: string; active: boolean }) {
      for (const socket of clients()) if (socket.data.userId !== packet.userId && socket.data.selectedId === packet.conversationId) {
        try { await service.authorizedOperation(socket.data.token, packet.conversationId, async ({ session }) => { await service.guardPair(socket.data.userId, packet.userId, session); }); socket.volatile.emit('sync:typing', packet); } catch { /* ephemeral hints expire */ }
      }
    }
    io.on('ephemeral:typing', (packet: { conversationId: string; userId: string; active: boolean }) => { if (!closing) void work.run(() => typing(packet)).catch(() => {}); });
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, config.HOST, resolve); });
  } catch (error) { await close(); throw error; }
  lifecycle.interval = setInterval(() => {
    for (const socket of clients()) if (!socket.data.checking) { socket.data.checking = true;
      void work.run(async () => {
        const principal = await identity(socket);
        if (socket.data.selectedId) {
          try { await service.detail(socket.data.token, socket.data.selectedId); }
          catch (error) { if (!(error instanceof DomainError && error.status === 403)) throw error; delete socket.data.selectedId; emitHint(socket, { kind: 'inbox' }); }
        }
        const watermark = await service.run(async session => { const current = await service.actor(socket.data.token, session); return (await service.inboxCounter(current.user._id, session)).sequence.toString(); });
        if (socket.data.inboxWatermark !== watermark) { socket.data.inboxWatermark = watermark; emitHint(socket, { kind: 'inbox' }); }
        if (await bounded(pub.withCommandOptions({ timeout: config.DEPENDENCY_TIMEOUT_MS }).eval(quotaScript, { keys: [quotaKey(socket.data.sessionId)], arguments: [socket.id, String(config.MAX_CONNECTIONS_PER_SESSION), 'renew'] })) !== 1) throw new Error('Lease expired');
        if (principal.user.privacy.showPresence) await bounded(pub.withCommandOptions({ timeout: config.DEPENDENCY_TIMEOUT_MS }).eval(presenceScript, { keys: [`${prefix}:presence:${socket.data.userId}`], arguments: ['ping', socket.id] }));
        else await bounded(pub.withCommandOptions({ timeout: config.DEPENDENCY_TIMEOUT_MS }).zRem(`${prefix}:presence:${socket.data.userId}`, socket.id));
      }).catch(() => socket.disconnect(true)).finally(() => { socket.data.checking = false; });
    }
  }, Math.min(10, config.SESSION_RECHECK_SECONDS) * 1000).unref();
  function beginDrain() { closing = true; if (lifecycle.interval) clearInterval(lifecycle.interval); }
  async function closeOwned() {
    beginDrain();
    await work.idle(config.DRAIN_TIMEOUT_MS);
    for (const socket of clients()) socket.emit('sync:reconnect', {});
    await new Promise<void>(resolve => io.close(() => resolve()));
    await work.idle(config.DRAIN_TIMEOUT_MS);
    for (const redis of [hints, sub, pub]) if (redis.isOpen) await bounded(redis.close()).catch(() => { if (redis.isOpen) redis.destroy(); });
    await auth.close(); await mongo.close(); metrics.clear();
  }
  function close() { return closePromise ??= closeOwned(); }
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Gateway address unavailable');
  return { io, close, beginDrain, service, url: `http://${config.HOST}:${address.port}` };
}
