import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import type { Socket } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { Long } from 'mongodb';
import { OperationsMonitor, BrokerTransport, eventReference, replayDeadLetters, SyncService, boundedText, aggregateMediaMetrics } from '@chat/domain';
import type { ControlEvent, OutboxRecord, UserRecord, ReplayFloor } from '@chat/domain';
import { operationalMetrics } from '@chat/observability';
import { snapshotAgent, assertLocalInspection, telemetryDirectory } from '../../scripts/telemetry-runtime.js';
import { messagingFixture, command, cleanBroker, waitFor } from './messaging-fixture.js';
import { telemetryFixture, faultProxy, through, reservePort, roleProcess } from './telemetry-fixture.js';
import type { DockerPortBindings } from './telemetry-fixture.js';

let f: Awaited<ReturnType<typeof messagingFixture>>, stack: Awaited<ReturnType<typeof telemetryFixture>>, broker: BrokerTransport, monitor: OperationsMonitor;
let actor: Awaited<ReturnType<typeof f.user>>, conversation: string;
const proxies: Record<string, Awaited<ReturnType<typeof faultProxy>>> = {}, processes: Partial<Record<'api' | 'gateway' | 'worker', Awaited<ReturnType<typeof roleProcess>>>> = {};
let config: typeof f.config, agent: Promise<void> | undefined, shutdown: AbortController | undefined, agentError: unknown;
function startAgent() { shutdown = new AbortController(); agent = snapshotAgent(config, stack.directory, shutdown.signal).catch(error => { agentError = error; }); }
const statuses: number[] = [];
beforeAll(async () => {
  f = await messagingFixture('dependencies_test', { CALLS_ENABLED: 'true', OPERATIONS_MEDIA_METRICS: 'true', OPERATIONS_PROBE_TIMEOUT_MS: '500', OPERATIONS_INTERVAL_MS: '1000', LOG_LEVEL: 'error' });
  for (const [name, value, defaultPort] of [['mongodb', f.config.MONGODB_URI, 27017], ['redis', f.config.REDIS_URL, 6379], ['rabbitmq', f.config.RABBITMQ_URL, 5672], ['rabbitHttp', f.config.RABBITMQ_MANAGEMENT_URL, 15672], ['storage', f.config.S3_ENDPOINT, 3900], ['image', f.config.IMAGE_PROCESSOR_URL, 3003], ['livekit', f.config.LIVEKIT_API_URL, 7880], ['media', f.config.LIVEKIT_METRICS_URL, 6789]] as const) { const url = new URL(value); proxies[name] = await faultProxy(url.hostname, Number(url.port || defaultPort)); }
  proxies['scanner'] = await faultProxy(f.config.CLAMAV_HOST, f.config.CLAMAV_PORT); proxies['smtp'] = await faultProxy(f.config.SMTP_HOST, f.config.SMTP_PORT);
  config = { ...f.config, DEPENDENCY_TIMEOUT_MS: 500, MONGODB_POOL_SIZE: 4, MONGODB_URI: through(f.config.MONGODB_URI, proxies['mongodb']!.port), REDIS_URL: through(f.config.REDIS_URL, proxies['redis']!.port), RABBITMQ_URL: through(f.config.RABBITMQ_URL, proxies['rabbitmq']!.port), RABBITMQ_MANAGEMENT_URL: through(f.config.RABBITMQ_MANAGEMENT_URL, proxies['rabbitHttp']!.port), S3_ENDPOINT: through(f.config.S3_ENDPOINT, proxies['storage']!.port), IMAGE_PROCESSOR_URL: through(f.config.IMAGE_PROCESSOR_URL, proxies['image']!.port), LIVEKIT_API_URL: through(f.config.LIVEKIT_API_URL, proxies['livekit']!.port), LIVEKIT_METRICS_URL: through(f.config.LIVEKIT_METRICS_URL, proxies['media']!.port), CLAMAV_PORT: proxies['scanner']!.port, SMTP_PORT: proxies['smtp']!.port };
  actor = await f.user('inspect'); conversation = (await f.service.createGroup(actor.token, randomUUID(), 'Dependency drill')).conversationId;
  broker = await BrokerTransport.open(f.config); monitor = new OperationsMonitor(config, 500);
  stack = await telemetryFixture();
});
afterAll(async () => {
  for (const proxy of Object.values(proxies)) proxy.setBlocked(false);
  shutdown?.abort(); await agent?.catch(() => {});
  if (stack) await writeFile(stack.directory + '/alerts.json', JSON.stringify(await stack.alerts()));
  for (const role of ['gateway', 'api', 'worker'] as const) await processes[role]?.close();
  await monitor?.close(); await broker?.close();
  if (f) { await cleanBroker(f); await f.close(); }
  for (const proxy of Object.values(proxies)) await proxy.close();
  await stack?.close();
});
async function sample(name: string) { const text = await operationalMetrics(); return Number(new RegExp(`^${name} ([0-9.eE+-]+)$`, 'm').exec(text)?.[1] ?? 0); }
async function post(input: ReturnType<typeof command>) {
  const response = await fetch(processes.api!.url + '/api/v1/messages', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Origin: config.WEB_ORIGIN, Cookie: `commonroom_session=${actor.token}`, 'X-CSRF-Token': actor.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  statuses.push(response.status); return { status: response.status, body: await response.json() as { eventId?: string; code?: string } };
}
async function alert(status: string, name: string, labels: Record<string, string>, after = 0) {
  await waitFor(async () => { if (agentError) throw agentError; return (await stack.alerts()).history.some(item => item.status === status && item.labels['alertname'] === name && item.receivedAt >= after && Object.entries(labels).every(([key, value]) => item.labels[key] === value)); }, 60000);
}
async function dependencyUp(name: string) { await waitFor(async () => (await stack.query(`chat_dependency_up{dependency="${name}"}`))[0]?.value[1] === '1', 45000); }
function expectPrivateBindings(ports: DockerPortBindings) {
  // Docker includes exposed-but-unpublished container ports as null map values.
  const bindings = Object.values(ports).flatMap(bindings => bindings ?? []);
  expect(bindings.length).toBeGreaterThan(0);
  expect(bindings.every(binding => binding.HostIp === '127.0.0.1')).toBe(true);
}

it('handles unpublished Docker ports while rejecting absent or non-loopback published bindings', () => {
  const privateBinding = { HostIp: '127.0.0.1', HostPort: '4318' };
  expectPrivateBindings({ '4317/tcp': null, '4318/tcp': [privateBinding], '55679/tcp': null });
  const unpublished: DockerPortBindings[] = [{}, { '4317/tcp': null }, { '4318/tcp': [] }];
  for (const ports of unpublished) expect(() => expectPrivateBindings(ports)).toThrow();
  for (const HostIp of ['0.0.0.0', '::', '192.0.2.1', '']) expect(() => expectPrivateBindings({ '4317/tcp': null, '4318/tcp': [privateBinding, { HostIp, HostPort: '4318' }] })).toThrow();
});

it('validates actual pinned rule/config binaries, retention and private container listeners', async () => {
  expect(await stack.compose(['exec', '-T', 'prometheus', 'promtool', 'check', 'config', '/etc/prometheus/prometheus.yaml'])).toContain('SUCCESS');
  expect(await stack.compose(['exec', '-T', 'prometheus', 'promtool', 'test', 'rules', '/etc/prometheus/rules.test.yaml'])).toContain('SUCCESS');
  expect(await stack.compose(['exec', '-T', 'alertmanager', 'amtool', 'check-config', '/etc/alertmanager/alertmanager.yaml'])).toContain('SUCCESS');
  await stack.compose(['exec', '-T', 'collector', '/otelcol-contrib', 'validate', '--config=/etc/otelcol/config.yaml']);
  const flags = await (await fetch(stack.endpoint + '/api/v1/status/flags')).json() as { data: Record<string, string> };
  expect(flags.data['storage.tsdb.retention.time']).toBe('2h'); expect(flags.data['storage.tsdb.retention.size']).toMatch(/^128/);
  const effective = JSON.parse(await stack.compose(['config', '--format', 'json'])) as { services: Record<string, { ports?: { host_ip: string }[]; mem_limit?: string | number }>; networks: Record<string, { internal?: boolean }> };
  for (const role of ['collector', 'prometheus', 'alertmanager']) expect(effective.services[role]?.ports?.every(port => port.host_ip === '127.0.0.1')).toBe(true);
  for (const role of ['collector', 'prometheus', 'alertmanager']) expectPrivateBindings(await stack.portBindings(role));
  expect(effective.services['telemetry-relay']?.ports).toBeUndefined(); expect(effective.networks['observing']?.internal).toBe(true);
});

it('probes actual protocols, records bounded inventory, and keeps disabled/unobserved capabilities honest', async () => {
  let text = '';
  await waitFor(async () => { text = await monitor.tick(); return ['mongodb', 'redis', 'rabbitmq', 'storage', 'scanner', 'image', 'livekit', 'smtp'].every(name => monitor.states[name as keyof typeof monitor.states].up); });
  for (const name of ['mongodb', 'redis', 'rabbitmq', 'storage', 'scanner', 'image', 'livekit', 'smtp']) expect(monitor.states[name as keyof typeof monitor.states], name).toMatchObject({ observed: true, up: true });
  expect(text).toContain('chat_inventory_observed 1'); expect(text).toContain('chat_broker_queue_observed{queue="fanout"} 1');
  expect(text).toContain('chat_mongo_members 1'); expect(text).toContain('chat_mongo_replication_lag_observed 0');
  expect(text).toContain('chat_dependency_enabled{dependency="push"} 0'); expect(text).toContain('chat_push_provider_observed 0');
  expect(text).toContain('chat_media_metrics_up 1');
  for (const secret of [actor.token, config.S3_SECRET_KEY, config.LIVEKIT_API_SECRET, config.REDIS_URL, config.RABBITMQ_URL, conversation, f.config.MONGODB_DATABASE]) expect(text).not.toContain(secret);
  const unknown = new OperationsMonitor({ ...config, PUSH_ENABLED: true }, 500);
  try { const result = await unknown.tick(); expect(result).toContain('chat_dependency_enabled{dependency="push"} 1'); expect(result).toContain('chat_dependency_observed{dependency="push"} 0'); } finally { await unknown.close(); }
});

it('bounds response/protocol inspection, prevents remote agent targets and drops all SFU identity labels', async () => {
  const server = createServer((request, response) => { if (request.url === '/redirect') { response.writeHead(302, { Location: '/large' }); response.end(); } else if (request.url === '/stall') { /* deadline must abort */ } else response.end('x'.repeat(8192)); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing');
  try { await expect(boundedText(`http://127.0.0.1:${address.port}/large`, 200, 64)).rejects.toThrow(); await expect(boundedText(`http://127.0.0.1:${address.port}/stall`, 200)).rejects.toThrow(); await expect(boundedText(`http://127.0.0.1:${address.port}/redirect`, 200)).rejects.toThrow(); }
  finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
  expect(() => assertLocalInspection({ ...config, S3_ENDPOINT: 'https://storage.example.test' })).toThrow('loopback');
  expect(() => assertLocalInspection({ ...config, NODE_ENV: 'production' })).toThrow('local-only');
  await expect(telemetryDirectory('../unsafe-telemetry-target')).rejects.toThrow('ignored workspace');
  const aggregate = aggregateMediaMetrics('livekit_room_total{room="PRIVATE_ROOM"} 2\nlivekit_room_total{room="PRIVATE_OTHER"} 3\nprovider_unknown{url="PRIVATE_URL"} 8\n');
  expect(aggregate).toContain('chat_media_aggregate{metric="rooms"} 5'); expect(aggregate).not.toContain('PRIVATE'); expect(aggregate).not.toContain('provider_unknown');
});

it('coalesces overlapping captures and bounds repeated failure backoff before real recovery', async () => {
  const bounded = new OperationsMonitor(config, 500);
  try {
    const first = bounded.tick(); expect(bounded.tick()).toBe(first); await first;
    proxies['scanner']!.setBlocked(true);
    for (let n = 0; n < 3; n++) await bounded.inspect('scanner', async () => { await boundedText(`http://127.0.0.1:${proxies['scanner']!.port}`, 100); return ''; });
    const last = bounded.states.scanner.last;
    expect(bounded.states.scanner).toMatchObject({ up: false, failures: 3 });
    expect(bounded.states.scanner.next - last).toBeLessThanOrEqual(600);
    let entered = false; await bounded.inspect('scanner', async () => { entered = true; return ''; }); expect(entered).toBe(false); expect(bounded.states.scanner.last).toBe(last);
    proxies['scanner']!.setBlocked(false);
    await waitFor(async () => { await bounded.tick(); return bounded.states.scanner.up; }); expect(bounded.states.scanner.failures).toBe(0);
  } finally { proxies['scanner']!.setBlocked(false); await bounded.close(); }
});

it('expires Redis and AMQP handshakes even when TCP accepts and never responds', async () => {
  const sockets = new Set<Socket>(), blackhole = createTcpServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  await new Promise<void>(done => blackhole.listen(0, '127.0.0.1', done)); const address = blackhole.address(); if (!address || typeof address === 'string') throw new Error('Fixture port missing');
  const stalled = new OperationsMonitor({ ...config, REDIS_URL: through(config.REDIS_URL, address.port), RABBITMQ_URL: through(config.RABBITMQ_URL, address.port), OPERATIONS_PROBE_TIMEOUT_MS: 200 }, 500);
  // Ensure even a regression can finish teardown; this fallback must never satisfy the deadline assertion.
  const fallback = setTimeout(() => { for (const socket of sockets) socket.destroy(); }, 1500);
  try { const started = performance.now(); await stalled.tick(); expect(performance.now() - started).toBeLessThan(1200); expect(stalled.states.redis).toMatchObject({ observed: true, up: false }); expect(stalled.states.rabbitmq).toMatchObject({ observed: true, up: false }); }
  finally { clearTimeout(fallback); for (const socket of sockets) socket.destroy(); await stalled.close(); await new Promise<void>(done => blackhole.close(() => done())); }
});

it('counts terminal duplicate/conflict and expired replay outcomes without adding data identifiers', async () => {
  const input = command(conversation), before = await sample('chat_message_duplicate_total'), conflicts = await sample('chat_message_dedup_conflict_total');
  await f.service.send(actor.token, input); await f.service.send(actor.token, input);
  await expect(f.service.send(actor.token, { ...input, text: 'Different digest' })).rejects.toMatchObject({ status: 409 });
  expect(await sample('chat_message_duplicate_total')).toBe(before + 1); expect(await sample('chat_message_dedup_conflict_total')).toBe(conflicts + 1);
  await f.db.collection<ReplayFloor>('replayFloors').insertOne({ _id: conversation, schemaVersion: 1, floor: Long.ONE, createdAt: new Date() });
  const expired = await sample('chat_replay_cursor_expired_total'); await expect(new SyncService(f.auth).replay(actor.token, conversation, '0')).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
  expect(await sample('chat_replay_cursor_expired_total')).toBe(expired + 1); await f.db.collection<ReplayFloor>('replayFloors').deleteOne({ _id: conversation });
});

it('keeps validated W3C context through audited operator DLQ replay even with the CLI SDK disabled', async () => {
  const operator = await f.user('operator'); await f.db.collection<UserRecord>('users').updateOne({ _id: operator.id }, { $set: { role: 'moderator' } });
  const canonical = (await f.db.collection<ControlEvent>('conversationEvents').findOne({ conversationId: conversation }))!, ref = eventReference(canonical), channel = await broker.channel();
  for (const parent of ['00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01', 'PRIVATE_INVALID_PARENT']) {
    await broker.publish(`${broker.prefix}.dead`, 'fanout', Buffer.from(JSON.stringify(ref)), { messageId: ref.eventId, headers: { traceparent: parent, baggage: 'PRIVATE_BAGGAGE' } });
    expect(await replayDeadLetters(f.service, broker, operator.token, 'fanout', 1)).toBe(1);
    const packet = await channel.get(broker.queue('fanout'), { noAck: false }); expect(packet).toBeTruthy(); if (!packet) throw new Error('Replay packet missing');
    expect(packet.properties.headers?.['traceparent']).toBe(parent.startsWith('00-') ? parent : undefined); expect(packet.properties.headers?.['baggage']).toBeUndefined(); channel.ack(packet);
  }
  expect(await f.db.collection('auditEvents').countDocuments({ action: 'dlq.replay_requested.fanout' })).toBe(2);
  expect(broker.failed).toBe(false); await broker.releaseChannel(channel); expect(broker.failed).toBe(false);
  const unexpected = await broker.channel(); await unexpected.close(); expect(broker.failed).toBe(true);
  await expect(broker.publish(broker.prefix, '', Buffer.from('{}'))).rejects.toThrow('unavailable');
});

it('exports a private connected trace from separate compiled API, worker and gateway processes into the actual collector', async () => {
  const [apiPort, gatewayPort, workerPort] = await Promise.all([reservePort(), reservePort(), reservePort()]); config = { ...config, API_PORT: apiPort, GATEWAY_PORT: gatewayPort, WORKER_PORT: workerPort };
  await f.db.collection('authEmailJobs').updateMany({}, { $set: { state: 'sent', encryptedPayload: null, completedAt: new Date() } });
  const env: NodeJS.ProcessEnv = { MONGODB_DATABASE: config.MONGODB_DATABASE, MONGODB_URI: config.MONGODB_URI, REDIS_URL: config.REDIS_URL, RABBITMQ_URL: config.RABBITMQ_URL, S3_ENDPOINT: config.S3_ENDPOINT, IMAGE_PROCESSOR_URL: config.IMAGE_PROCESSOR_URL, CLAMAV_PORT: String(config.CLAMAV_PORT), LIVEKIT_API_URL: config.LIVEKIT_API_URL, SMTP_PORT: String(config.SMTP_PORT), DEPENDENCY_TIMEOUT_MS: '500', CALLS_ENABLED: 'true', OTEL_TRACE_ENABLED: 'true', OTEL_TRACE_SAMPLE_RATIO: '1', OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: stack.otlp, BROKER_RETRY_BASE_MS: '100', BROKER_RETRY_ATTEMPTS: '2' };
  for (const [role, port] of [['api', apiPort], ['gateway', gatewayPort], ['worker', workerPort]] as const) processes[role] = await roleProcess(role, env, port);
  await waitFor(async () => (await fetch(processes.worker!.url + '/health/ready')).ok, 20000);
  startAgent();
  const privateText = 'PRIVATE_DISTRIBUTED_BODY_08B', result = await post(command(conversation, privateText)); expect(result.status).toBe(200);
  const row = (await f.db.collection<OutboxRecord>('outbox').findOne({ _id: result.body.eventId! }))!, traceId = row.traceparent!.split('-')[1];
  let bytes = ''; let chain: { service: string; name: string; spanId: string; parentSpanId?: string }[] = [];
  await waitFor(async () => {
    try { bytes = await stack.traces(); } catch { return false; }
    chain = [];
    for (const line of bytes.trim().split('\n')) {
      const data = JSON.parse(line) as { resourceSpans?: { resource?: { attributes?: { key: string; value: { stringValue?: string } }[] }; scopeSpans?: { spans?: { name: string; traceId: string; spanId: string; parentSpanId?: string }[] }[] }[] };
      for (const resource of data.resourceSpans ?? []) for (const scope of resource.scopeSpans ?? []) for (const span of scope.spans ?? []) if (span.traceId === traceId) chain.push({ ...span, service: resource.resource?.attributes?.find(item => item.key === 'service.name')?.value.stringValue ?? '' });
    }
    return ['commonroom-api', 'commonroom-worker', 'commonroom-gateway'].every(service => chain.some(span => span.service === service)) && ['http.request', 'outbox.publish', 'broker.consume', 'fanout.publish', 'gateway.dispatch'].every(name => chain.some(span => span.name === name));
  }, 30000);
  expect(chain.map(span => span.service)).toEqual(expect.arrayContaining(['commonroom-api', 'commonroom-worker', 'commonroom-gateway']));
  expect(chain.map(span => span.name)).toEqual(expect.arrayContaining(['http.request', 'outbox.publish', 'broker.consume', 'fanout.publish', 'gateway.dispatch']));
  expect(chain.find(span => span.name === 'outbox.publish')?.parentSpanId).toBe(chain.find(span => span.name === 'http.request')?.spanId);
  for (const privateValue of [privateText, actor.token, actor.csrf, conversation, config.MONGODB_DATABASE]) expect(bytes).not.toContain(privateValue);
  await waitFor(async () => (await stack.query('chat_snapshot_fresh{role="api"}'))[0]?.value[1] === '1');
  await expect(snapshotAgent(config, stack.directory, new AbortController().signal)).rejects.toMatchObject({ code: 'EEXIST' });
  await waitFor(async () => Number((await stack.query('chat_projection_publish_lag_seconds_count{role="worker"}'))[0]?.value[1]) > 0);
});

it('filters unexpected span attributes, status text, events, links and services at the real collector', async () => {
  const sentinel = 'PRIVATE_COLLECTOR_SENTINEL_08B', now = BigInt(Date.now()) * 1000000n;
  const span = { traceId: 'dddddddddddddddddddddddddddddddd', spanId: 'eeeeeeeeeeeeeeee', name: 'http.request', kind: 2, startTimeUnixNano: now.toString(), endTimeUnixNano: (now + 1000000n).toString(), attributes: [{ key: 'body', value: { stringValue: sentinel } }, { key: 'http.route', value: { stringValue: '/api/v1/messages' } }], status: { code: 2, message: sentinel }, events: [{ name: sentinel, timeUnixNano: now.toString(), attributes: [{ key: 'exception.message', value: { stringValue: sentinel } }] }], links: [{ traceId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', spanId: 'bbbbbbbbbbbbbbbb', attributes: [{ key: 'token', value: { stringValue: sentinel } }] }] };
  const body = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'commonroom-api' } }, { key: 'password', value: { stringValue: sentinel } }] }, scopeSpans: [{ scope: { name: 'commonroom' }, spans: [{ ...span, links: [] }, { ...span, name: sentinel, spanId: 'ffffffffffffffff' }, { ...span, spanId: '1111111111111111' }] }] }] };
  body.resourceSpans.push({ resource: { attributes: [{ key: 'service.name', value: { stringValue: sentinel } }] }, scopeSpans: [{ scope: { name: 'commonroom' }, spans: [{ ...span, links: [], spanId: '2222222222222222' }] }] });
  expect((await fetch(stack.otlp, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).ok).toBe(true);
  let bytes = ''; await waitFor(async () => { bytes = await stack.traces(); return bytes.includes(span.traceId); }); expect(bytes).not.toContain(sentinel); expect(bytes).not.toContain('1111111111111111'); expect(bytes).not.toContain('2222222222222222');
});

it('fires and resolves real core-dependency alerts while preserving fail-closed writes and broker-outage acceptance', async () => {
  for (const dependency of ['mongodb', 'redis', 'rabbitmq']) {
    await dependencyUp(dependency); const since = Date.now(); proxies[dependency]!.setBlocked(true);
    try {
      await alert('firing', 'CommonroomDependencyUnavailable', { dependency }, since);
      expect((await fetch(processes.api!.url + '/health/live')).status).toBe(200);
      const input = command(conversation, `Fault ${dependency}`), response = await post(input);
      if (dependency === 'rabbitmq') {
        expect(response.status).toBe(200); expect((await f.db.collection<OutboxRecord>('outbox').findOne({ _id: response.body.eventId! }))?.status).not.toBe('published');
        expect((await fetch(processes.worker!.url + '/health/ready')).status).toBe(503);
      } else { expect(response.status).toBe(503); expect(await f.db.collection('messages').countDocuments({ clientMessageId: input.clientMessageId })).toBe(0); }
      if (dependency === 'redis') expect((await fetch(processes.gateway!.url + '/health/ready')).status).toBe(503);
      if (dependency === 'mongodb') expect((await fetch(processes.api!.url + '/health/ready')).status).toBe(503);
    } finally { proxies[dependency]!.setBlocked(false); }
    await dependencyUp(dependency); await alert('resolved', 'CommonroomDependencyUnavailable', { dependency }, since);
    await waitFor(async () => (await fetch(processes.worker!.url + '/health/ready')).ok, 40000);
    await waitFor(async () => await f.db.collection('outbox').countDocuments({ status: { $in: ['pending', 'claimed'] } }) === 0, 30000);
  }
}, 240000);

it('alerts on optional dependency faults without globally disabling chat and retains SMTP jobs for recovery', async () => {
  const optional = ['storage', 'scanner', 'image', 'livekit', 'smtp']; for (const name of optional) await dependencyUp(name);
  const since = Date.now(); for (const name of optional) proxies[name]!.setBlocked(true);
  try {
    await Promise.all(optional.map(dependency => alert('firing', 'CommonroomDependencyUnavailable', { dependency }, since)));
    expect((await post(command(conversation, 'Chat while optional providers are unavailable'))).status).toBe(200);
    expect((await fetch(processes.api!.url + '/health/ready')).status).toBe(200);
    const response = await fetch(processes.api!.url + '/api/v1/calls', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Origin: config.WEB_ORIGIN, Cookie: `commonroom_session=${actor.token}`, 'X-CSRF-Token': actor.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: randomUUID(), conversationId: conversation, mode: 'voice' }) }); expect(response.status).toBe(503);
    const queued = await f.user('smtpfault'); await waitFor(async () => !!await f.db.collection('authEmailJobs').findOne({ userId: queued.id, state: 'pending', attempts: { $gte: 1 }, encryptedPayload: { $type: 'string' } }));
    // End the synthetic mail fixture before unblocking the real development receiver.
    await f.db.collection('authEmailJobs').updateMany({ userId: queued.id }, { $set: { state: 'dead', encryptedPayload: null, completedAt: new Date() } });
  } finally { for (const name of optional) proxies[name]!.setBlocked(false); }
  await Promise.all(optional.map(async dependency => { await dependencyUp(dependency); await alert('resolved', 'CommonroomDependencyUnavailable', { dependency }, since); }));
});

it('marks a stopped host agent stale instead of replaying cached health and resolves after fresh capture', async () => {
  const since = Date.now(); shutdown!.abort(); await agent; agent = undefined;
  await alert('firing', 'CommonroomSnapshotStale', { role: 'ops' }, since);
  expect((await stack.query('chat_snapshot_fresh{role="ops"}'))[0]?.value[1]).toBe('0');
  expect(await stack.query('chat_dependency_up{dependency="mongodb"}')).toHaveLength(0);
  startAgent();
  await dependencyUp('mongodb'); await alert('resolved', 'CommonroomSnapshotStale', { role: 'ops' }, since);
  expect((await readFile(stack.directory + '/snapshots/ops.json', 'utf8'))).not.toContain(config.S3_SECRET_KEY);
  expect(statuses).toContain(200); expect(statuses).toContain(503);
});
