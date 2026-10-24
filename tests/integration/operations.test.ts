import { createServer } from 'node:http';
import { createServer as portReservation } from 'node:net';
import { spawn } from 'node:child_process';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { createApi } from '@chat/api';
import { createGateway } from '@chat/gateway';
import { AuthService, BrokerTransport, EventConsumer, OutboxRelay, FanoutWorker, CallService, CallWorker, SyncService, runMigrations, mongoPoolMetrics } from '@chat/domain';
import type { OutboxRecord, ControlEvent } from '@chat/domain';
import { startTelemetry, traced, traceCarrier, safeTraceparent, createLogger } from '@chat/observability';
import { messagingFixture, command, cleanBroker, waitFor } from './messaging-fixture.js';

interface ExportedSpan { name: string; traceId: string; spanId: string; parentSpanId?: string; attributes?: { key: string; value: unknown }[] }
const exported: ExportedSpan[] = []; const payloads: string[] = [];
let failExport = false, received = 0;
const collector = createServer((request, response) => {
  let body = ''; request.setEncoding('utf8'); request.on('data', chunk => { body += chunk; if (body.length > 1048576) request.destroy(); });
  request.on('end', () => {
    received++; if (failExport) { response.writeHead(503); response.end(); return; }
    payloads.push(body);
    const data = JSON.parse(body) as { resourceSpans?: { scopeSpans?: { spans?: ExportedSpan[] }[] }[] };
    for (const resource of data.resourceSpans ?? []) for (const scope of resource.scopeSpans ?? []) exported.push(...scope.spans ?? []);
    response.setHeader('Content-Type', 'application/json'); response.end('{}');
  });
});
let telemetry: ReturnType<typeof startTelemetry>, f: Awaited<ReturnType<typeof messagingFixture>>;
let api: Awaited<ReturnType<typeof createApi>> | undefined, gateway: Awaited<ReturnType<typeof createGateway>> | undefined;
let broker: BrokerTransport | undefined, fanout: FanoutWorker | undefined;
const consumers: EventConsumer[] = [];
beforeAll(async () => {
  await new Promise<void>(resolve => collector.listen(0, '127.0.0.1', resolve));
  const address = collector.address(); if (!address || typeof address === 'string') throw new Error('Collector port missing');
  telemetry = startTelemetry('api', { OTEL_TRACE_ENABLED: true, OTEL_TRACE_SAMPLE_RATIO: 1, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces` });
});
beforeEach(async () => { f = await messagingFixture('operations_test', { LOG_LEVEL: 'error', JOB_CONCURRENCY: '1' }); });
afterEach(async () => {
  vi.restoreAllMocks(); failExport = false;
  for (const consumer of consumers.splice(0)) await consumer.stop();
  await api?.close(); api = undefined; await gateway?.close(); gateway = undefined; await fanout?.close(); fanout = undefined;
  await broker?.close(); broker = undefined; await cleanBroker(f); await f.close();
});
afterAll(async () => { await telemetry.close(); await new Promise<void>(resolve => collector.close(() => resolve())); });
const barrier = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
async function setup() { const actor = await f.user('operations'), id = (await f.service.createGroup(actor.token, randomUUID(), 'Operations fixture')).conversationId; return { actor, id }; }
async function publishAll() { const relay = new OutboxRelay(f.service, broker!); while (await relay.runOnce()) { /* finite fixture */ } }

it('correlates actual HTTP acceptance, outbox, Rabbit consumption, Redis fanout and gateway dispatch without private payloads', async () => {
  const { actor, id } = await setup(); api = await createApi(f.config); gateway = await createGateway(f.config, 0); broker = await BrokerTransport.open(f.config);
  const privateText = 'PRIVATE_BODY_SENTINEL_08', privateQuery = 'PRIVATE_QUERY_SENTINEL_08';
  const response = await api.app.inject({ method: 'POST', url: `/api/v1/messages?private=${privateQuery}`, headers: { origin: f.config.WEB_ORIGIN, cookie: `commonroom_session=${actor.token}`, 'x-csrf-token': actor.csrf, 'content-type': 'application/json', traceparent: '00-11111111111111111111111111111111-2222222222222222-01', baggage: 'secret=PRIVATE_BAGGAGE_08' }, payload: command(id, privateText) });
  expect(response.statusCode).toBe(200); const sent = response.json<{ eventId: string }>();
  const row = await f.db.collection<OutboxRecord>('outbox').findOne({ _id: sent.eventId }); expect(safeTraceparent(row?.traceparent)).toBeTruthy();
  const traceId = row!.traceparent!.split('-')[1]; expect(traceId).not.toBe('11111111111111111111111111111111');
  await publishAll(); const channel = await broker.channel(), consumer = new EventConsumer(f.service, broker, 'fanout');
  let packet; while ((packet = await channel.get(broker.queue('fanout'), { noAck: false }))) {
    expect(Object.keys(JSON.parse(packet.content.toString())).sort()).toEqual(['conversationId', 'eventId', 'kind', 'sequence', 'v']);
    if (packet.properties.messageId === sent.eventId) expect(safeTraceparent(packet.properties.headers?.['traceparent'])).toBeTruthy();
    await consumer.process(packet, channel);
  }
  fanout = new FanoutWorker(f.db, f.config); while (await fanout.runOnce()) { /* actual Redis publication */ }
  await waitFor(async () => { await telemetry.flush(); return exported.some(span => span.traceId === traceId && span.name === 'gateway.dispatch'); });
  const chain = exported.filter(span => span.traceId === traceId); expect(chain.map(span => span.name)).toEqual(expect.arrayContaining(['http.request', 'outbox.publish', 'broker.consume', 'fanout.publish', 'gateway.dispatch']));
  expect(chain.find(span => span.name === 'outbox.publish')?.parentSpanId).toBe(chain.find(span => span.name === 'http.request')?.spanId);
  expect(chain.find(span => span.name === 'broker.consume')?.parentSpanId).toBe(chain.find(span => span.name === 'outbox.publish')?.spanId);
  const bytes = payloads.join(''); for (const secret of [privateText, privateQuery, actor.token, actor.csrf, 'PRIVATE_BAGGAGE_08', id]) expect(bytes).not.toContain(secret);
  const metrics = (await api.app.inject({ url: '/metrics' })).body;
  expect(metrics).toContain('route="/api/v1/messages",status="200"'); expect(metrics).not.toContain(privateQuery); expect(metrics).toContain('chat_mongo_pool_connections');
  expect(await f.db.collection('consumerEffects').countDocuments({ eventId: sent.eventId })).toBe(1);
});

it('keeps traces out of old-schema writes and permits old v1 rows after additive migration reruns', async () => {
  const { actor, id } = await setup();
  await f.db.collection<{ _id: string }>('schemaMigrations').deleteOne({ _id: '008_operations' });
  const info = await f.db.listCollections({ name: 'outbox' }).next(); if (!info || !('options' in info)) throw new Error('Validator missing');
  const validator = info.options?.validator; delete validator?.['$jsonSchema'].properties.traceparent;
  await f.db.command({ collMod: 'outbox', validator });
  const old = await traced('old-schema.command', {}, () => f.service.send(actor.token, command(id)));
  expect((await f.db.collection<OutboxRecord>('outbox').findOne({ _id: old.eventId }))?.traceparent).toBeUndefined();
  await runMigrations(f.db); await runMigrations(f.db);
  const fresh = await traced('new-schema.command', {}, () => f.service.send(actor.token, command(id)));
  expect(safeTraceparent((await f.db.collection<OutboxRecord>('outbox').findOne({ _id: fresh.eventId }))?.traceparent)).toBeTruthy();
  // Direct old-format insert represents the unchanged v1 writer, without optional metadata.
  const source = (await f.db.collection<OutboxRecord>('outbox').findOne({ _id: old.eventId }))!;
  await f.db.collection<OutboxRecord>('outbox').insertOne({ ...source, _id: randomUUID(), eventId: randomUUID() });
  await expect(f.db.collection<OutboxRecord>('outbox').updateOne({ _id: old.eventId }, { $set: { traceparent: 'body-or-invalid-parent' } })).rejects.toMatchObject({ code: 121 });
  expect(await f.db.collection('schemaMigrations').countDocuments()).toBe(11);
});

it('preserves safe context through actual broker retry and dead-letter handoffs', async () => {
  const { id } = await setup(); broker = await BrokerTransport.open(f.config); const channel = await broker.channel(), consumer = new EventConsumer(f.service, broker, 'fanout');
  const event = (await f.db.collection<ControlEvent>('conversationEvents').findOne({ conversationId: id }))!;
  const reference = { v: 1, eventId: event._id, conversationId: id, sequence: event.sequence.toString(), kind: event.kind };
  const parent = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
  await broker.publish(broker.prefix, '', Buffer.from(JSON.stringify(reference)), { messageId: event._id, headers: { traceparent: parent } });
  vi.spyOn(consumer, 'apply').mockRejectedValue(new Error('PRIVATE_ERROR_SENTINEL_08'));
  for (let attempt = 0; attempt < 3; attempt++) {
    let packet: Awaited<ReturnType<typeof channel.get>> = false;
    await waitFor(async () => { packet = await channel.get(broker!.queue('fanout'), { noAck: false }); return !!packet; });
    if (!packet) throw new Error('Retry missing'); await consumer.process(packet, channel);
  }
  const dead = await channel.get(`${broker.queue('fanout')}.dead`, { noAck: true }); expect(dead).toBeTruthy();
  if (!dead) throw new Error('Dead letter missing'); expect(dead.properties.headers?.['traceparent']).toMatch(/^00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-/);
  await telemetry.flush(); expect(payloads.join('')).not.toContain('PRIVATE_ERROR_SENTINEL_08');
});

it('stops broker intake while an accepted effect finishes before shutdown', async () => {
  await setup(); broker = await BrokerTransport.open(f.config); await publishAll();
  const consumer = new EventConsumer(f.service, broker, 'fanout'); consumers.push(consumer);
  const accepted = barrier(), release = barrier(), original = consumer.apply.bind(consumer);
  vi.spyOn(consumer, 'apply').mockImplementation(async reference => { accepted.release(); await release.promise; return original(reference); });
  try {
    await consumer.start(); await accepted.promise; await consumer.stopIntake();
    let settled = false; const stopped = consumer.stop().then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 50)); expect(settled).toBe(false);
    const { actor, id } = await setup(); await f.service.send(actor.token, command(id)); await publishAll();
    release.release(); await stopped; expect(consumer.apply).toHaveBeenCalledTimes(1);
    expect(await f.db.collection('consumerEffects').countDocuments()).toBe(1);
    const channel = await broker.channel(); expect((await channel.checkQueue(broker.queue('fanout'))).messageCount).toBeGreaterThan(0);
  } finally { release.release(); }
});

it('refuses new HTTP work/readiness while an accepted real message commits and closes idempotently', async () => {
  const { actor, id } = await setup(); api = await createApi(f.config);
  await api.app.listen(0, '127.0.0.1'); const url = await api.app.getUrl();
  const service = api.app.get<SyncService>('MESSAGE_SERVICE'), original = service.send.bind(service), accepted = barrier(), release = barrier();
  vi.spyOn(service, 'send').mockImplementation(async (...args) => { accepted.release(); await release.promise; return original(...args); });
  const input = command(id), response = fetch(`${url}/api/v1/messages`, { method: 'POST', headers: { origin: f.config.WEB_ORIGIN, cookie: `commonroom_session=${actor.token}`, 'x-csrf-token': actor.csrf, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  try {
    await Promise.race([accepted.promise, response.then(result => { throw new Error(`Request finished before handler: ${result.status}`); })]); api.beginDrain();
    expect((await fetch(`${url}/health/ready`)).status).toBe(503);
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
    const rejected = await fetch(`${url}/api/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(command(id)) });
    expect(rejected.status).toBe(503); expect(rejected.headers.get('retry-after')).toBe('1');
    expect((await rejected.json() as { requestId: string }).requestId).toBe(rejected.headers.get('x-request-id'));
    let settled = false; const closing = api.close().then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 50)); expect(settled).toBe(false);
    release.release(); const result = await response; expect(result.status).toBe(200); const sent = await result.json() as { eventId: string }; await closing; await api.close();
    expect((await f.service.send(actor.token, input)).eventId).toBe(sent.eventId);
    expect(await f.db.collection('messages').countDocuments({ conversationId: id })).toBe(1);
  } finally { release.release(); await response.catch(() => {}); }
});

it('keeps accepted handlers alive after a real client abort and recovers one idempotent result', async () => {
  const { actor, id } = await setup(); api = await createApi(f.config);
  await api.app.listen(0, '127.0.0.1'); const url = await api.app.getUrl();
  const service = api.app.get<SyncService>('MESSAGE_SERVICE'), original = service.send.bind(service), accepted = barrier(), release = barrier();
  vi.spyOn(service, 'send').mockImplementation(async (...args) => { accepted.release(); await release.promise; return original(...args); });
  const input = command(id), controller = new AbortController();
  const request = fetch(`${url}/api/v1/messages`, { method: 'POST', signal: controller.signal, headers: { origin: f.config.WEB_ORIGIN, cookie: `commonroom_session=${actor.token}`, 'x-csrf-token': actor.csrf, 'content-type': 'application/json' }, body: JSON.stringify(input) });
  const outcome = request.then(result => result.status, () => 'aborted');
  try {
    await Promise.race([accepted.promise, outcome.then(status => { throw new Error(`Early response: ${status}`); })]);
    controller.abort(); expect(await outcome).toBe('aborted'); api.beginDrain();
    let settled = false; const closing = api.close().then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 80)); expect(settled).toBe(false);
    release.release(); await closing;
    const retry = await f.service.send(actor.token, input);
    expect(await f.db.collection('messages').countDocuments({ conversationId: id })).toBe(1);
    expect(await f.db.collection<OutboxRecord>('outbox').countDocuments({ eventId: retry.eventId })).toBe(1);
  } finally { release.release(); controller.abort(); await outcome; }
});

it('waits for accepted gateway work even after its socket disconnects, and rejects later commands', async () => {
  const { actor, id } = await setup(); gateway = await createGateway(f.config, 0);
  const client = io(gateway.url, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { Origin: f.config.WEB_ORIGIN, Cookie: `commonroom_session=${actor.token}` }, auth: { csrf: actor.csrf } });
  const accepted = barrier(), release = barrier(), original = gateway.service.detail.bind(gateway.service);
  vi.spyOn(gateway.service, 'detail').mockImplementation(async (...args) => { accepted.release(); await release.promise; return original(...args); });
  try {
    await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
    client.emit('sync:subscribe', { conversationId: id }, () => {}); await accepted.promise; gateway.beginDrain();
    expect((await fetch(`${gateway.url}/health/ready`)).status).toBe(503); expect((await fetch(`${gateway.url}/health/live`)).status).toBe(200);
    expect(await client.timeout(2000).emitWithAck('sync:subscribe', { conversationId: id })).toEqual({ ok: false });
    client.disconnect(); let settled = false; const closing = gateway.close().then(() => { settled = true; });
    await new Promise(resolve => setTimeout(resolve, 80)); expect(settled).toBe(false);
    release.release(); await closing; expect(await f.service.detail(actor.token, id)).toMatchObject({ id }); await gateway.close();
  } finally { release.release(); client.disconnect(); }
});

it('contains exporter outages and adds redacted log correlation without changing acknowledged writes', async () => {
  const { actor, id } = await setup(); const output: string[] = [];
  const destination = new Writable({ write(chunk, _encoding, done) { output.push(chunk.toString()); done(); } });
  const logger = createLogger('operations-test', 'info', destination);
  failExport = true; const before = received;
  const sent = await traced('exporter-failure.command', {}, async () => {
    logger.info({ password: 'PRIVATE_PASSWORD_08', body: 'PRIVATE_LOG_BODY_08', authorization: actor.token, ...traceCarrier() }, 'accepted');
    return f.service.send(actor.token, command(id));
  });
  await telemetry.flush(); expect(received).toBeGreaterThan(before);
  expect(await f.db.collection<{ _id: string }>('messages').countDocuments({ _id: sent.message.messageId })).toBe(1);
  const log = JSON.parse(output.join('')) as Record<string, string>; expect(log['traceId']).toMatch(/^[a-f0-9]{32}$/);
  expect(output.join('')).not.toMatch(/PRIVATE_PASSWORD_08|PRIVATE_LOG_BODY_08/); expect(output.join('')).not.toContain(actor.token);
  expect(safeTraceparent('00-00000000000000000000000000000000-bbbbbbbbbbbbbbbb-01')).toBeUndefined();
  expect(mongoPoolMetrics(f.client)).toMatch(/chat_mongo_pool_checked_out 0\n/);
  failExport = false; await traced('exporter-recovered', {}, async () => {}); await telemetry.flush(); expect(exported.some(span => span.name === 'exporter-recovered')).toBe(true);
});

it('blocks fresh media allocation/credentials during maintenance while existing calls can end and reconcile', async () => {
  const { actor, id } = await setup();
  const live = new CallService(new AuthService({ ...f.config, CALLS_ENABLED: true }, f.client, f.db)), sync = new SyncService(f.auth);
  const peer = await f.user('mediapeer'); await sync.invite(actor.token, id, peer.id); await sync.respondInvitation(peer.token, id, true);
  const worker = new CallWorker(live), maintenance = new CallService(new AuthService({ ...f.config, CALLS_ENABLED: true, MEDIA_DRAINING: true }, f.client, f.db));
  const call = await live.start(actor.token, { commandId: randomUUID(), conversationId: id, mode: 'voice' });
  try {
    const paused = new CallWorker(maintenance);
    await paused.runOnce();
    const pending = (await live.rooms().findOne({ callId: call.id }))!;
    expect(pending.state).toBe('pending'); expect(await live.provider.participants(pending._id)).toBeNull();
    await live.calls().updateOne({ _id: call.id }, { $set: { availableAt: new Date(0) } });
    await worker.runOnce(); expect((await maintenance.status(actor.token)).available).toBe(false);
    await expect(maintenance.start(actor.token, { commandId: randomUUID(), conversationId: id, mode: 'voice' })).rejects.toMatchObject({ status: 503 });
    await expect(maintenance.join(actor.token, call.id)).rejects.toMatchObject({ status: 503 });
    await maintenance.action(actor.token, call.id, { commandId: randomUUID(), action: 'end' });
    await live.calls().updateOne({ _id: call.id }, { $set: { availableAt: new Date(0) } }); await paused.runOnce();
    expect((await live.get(actor.token, call.id)).state).toBe('ended');
    expect(await live.rooms().countDocuments({ callId: call.id, state: { $ne: 'deleted' } })).toBe(0);
  } finally { for (const room of await live.rooms().find({ callId: call.id }).toArray()) await live.provider.removeRoom(room._id); }
});


it('drains actual API/gateway/worker entrypoints with readiness propagation and preserves a worker-accepted publication', async () => {
  const { actor, id } = await setup(), input = command(id), sent = await f.service.send(actor.token, input);
  // No test account mail reaches the preserved development receiver.
  await f.db.collection('authEmailJobs').updateMany({}, { $set: { state: 'sent', encryptedPayload: null, completedAt: new Date() } });
  for (const role of ['api', 'gateway', 'worker'] as const) {
    const reserve = portReservation(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve));
    const address = reserve.address(); if (!address || typeof address === 'string') throw new Error('Process port missing');
    await new Promise<void>(resolve => reserve.close(() => resolve())); const url = `http://127.0.0.1:${address.port}`;
    const child = spawn(process.execPath, ['tests/fixtures/drain-process.mjs', role], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: f.config.MONGODB_DATABASE, [`${role.toUpperCase()}_PORT`]: String(address.port), BROKER_RETRY_BASE_MS: '100', BROKER_RETRY_ATTEMPTS: '2', DRAIN_DELAY_MS: '1000', LOG_LEVEL: 'error', CALLS_ENABLED: 'false', OTEL_TRACE_ENABLED: 'false' } });
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    try {
      await waitFor(async () => { if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Exited ${role}: ${child.exitCode ?? child.signalCode}`); try { return (await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, 20000);
      if (role === 'worker') await waitFor(async () => (await f.db.collection<OutboxRecord>('outbox').findOne({ _id: sent.eventId }))?.status === 'published');
      if (process.platform === 'win32') child.send('test:terminate'); else child.kill('SIGTERM');
      await waitFor(async () => { try { return (await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(500) })).status === 503; } catch { return false; } }, 1000);
      expect((await fetch(`${url}/health/live`)).status).toBe(200);
      expect(await exited).toBe(0);
    } finally { if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited; } }
  }
  expect(await f.db.collection('messages').countDocuments({ conversationId: id })).toBe(1);
  expect((await f.service.send(actor.token, input)).eventId).toBe(sent.eventId);
}, 90000);
