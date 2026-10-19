import { realpath, readFile } from 'node:fs/promises';
import { relative, join, isAbsolute } from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { setTimeout, clearTimeout } from 'node:timers';
import { pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';

// Test-only IPC driver. All domain/config imports resolve from the selected release.
const root = await realpath('.'), directory = await realpath(process.argv[2]);
const rel = relative(root, directory).replaceAll('\\', '/');
if (directory !== root && !rel.startsWith('.cache/upgrade-artifacts/')) throw new Error('Unsupported artifact directory');
const modulePath = await realpath(join(directory, 'packages/domain/dist/index.js'));
function contained(path) { const rel = relative(directory, path); return !isAbsolute(rel) && !rel.startsWith('..'); }
if (!contained(modulePath)) throw new Error('Cross-artifact domain');
async function validateDependencies(packagePath) {
  const packageFile = join(directory, packagePath, 'package.json'), requireArtifact = createRequire(packageFile);
  const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
  for (const name of Object.keys(manifest.dependencies).filter(name => name.startsWith('@chat/'))) {
    if (!contained(await realpath(requireArtifact.resolve(name)))) throw new Error('Cross-artifact dependency');
  }
  return manifest;
}
const manifest = await validateDependencies('packages/domain');
const domain = await import(pathToFileURL(modulePath).href);
const { loadConfig } = await import(pathToFileURL(join(directory, 'packages/config/dist/index.js')).href);
const config = loadConfig();
if (config.NODE_ENV !== 'test' || !/^upgrade_test_[a-f0-9]{32}$/.test(config.MONGODB_DATABASE)) throw new Error('Upgrade driver requires an isolated ordinary database');
// Exercise the additive trace field in the real current HTTP writer. Export is
// deliberately bounded to a closed loopback port; collector export is an 08B gate.
const telemetry = manifest.dependencies['@chat/observability'] ? (await import(pathToFileURL(join(directory, 'packages/observability/dist/index.js')).href)).startTelemetry('api', { ...config, OTEL_TRACE_ENABLED: true, OTEL_TRACE_SAMPLE_RATIO: 1, OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'http://127.0.0.1:1/v1/traces' }) : undefined;
const client = domain.createMongoClient(config); await client.connect();
const db = client.db(config.MONGODB_DATABASE), auth = new domain.AuthService(config, client, db);
await auth.initialize();
const service = new domain.SyncService(auth), broker = await domain.BrokerTransport.open(config), consumers = [], stats = new domain.DeliveryStats();
let held, queue = Promise.resolve(), closing, api;
const send = value => { if (process.connected) process.send(value); };
const barrier = (id, data) => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => { held = undefined; reject(new Error('Barrier expired')); }, 90000);
  held = () => { clearTimeout(timeout); held = undefined; resolve(); };
  send({ kind: 'barrier', id, data });
});
function close() { return closing ??= (async () => { for (const consumer of consumers) await consumer.stop(); await api?.close(); await telemetry?.close(); await broker.close(); await auth.close(); await client.close(); })(); }
async function operation(id, op, data) {
  if (op === 'http-start') {
    if (api) throw new Error('HTTP already started');
    const path = await realpath(join(directory, 'apps/api/dist/app.js'));
    if (!contained(path)) throw new Error('Cross-artifact HTTP API');
    await validateDependencies('apps/api');
    api = await (await import(pathToFileURL(path).href)).createApi(config); await api.app.listen(0, '127.0.0.1');
    return { url: `http://127.0.0.1:${api.app.getHttpServer().address().port}`, modulePath: path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') };
  }
  if (op === 'migrate') { await domain.runMigrations(db); return db.collection('schemaMigrations').countDocuments(); }
  if (op === 'user') {
    const username = `upgrade_${randomUUID().slice(0, 8)}`, email = `${username}@example.test`, password = 'Synthetic-upgrade-password-123';
    await auth.register({ username, email, password, displayName: 'Upgrade fixture' });
    const user = await db.collection('users').findOne({ emailCanonical: email });
    const job = await db.collection('authEmailJobs').findOne({ userId: user._id });
    const text = JSON.parse(domain.unseal(job.encryptedPayload, config.AUTH_EMAIL_KEY)).text;
    await auth.consumeToken(text.match(/\/verify#token=([A-Za-z0-9_-]{43})/)[1], 'verify');
    const login = await auth.login({ email, password, deviceLabel: 'Upgrade test' }); return { id: user._id, token: login.token, csrf: login.session.csrfToken };
  }
  if (op === 'group') return service.createGroup(data.token, data.commandId, 'Upgrade group');
  if (op === 'invite') return service.invite(data.token, data.conversationId, data.userId);
  if (op === 'accept') return service.respondInvitation(data.token, data.conversationId, true);
  if (op === 'remove') return service.remove(data.token, data.conversationId, data.userId);
  if (op === 'send') return service.send(data.token, data.command);
  if (op === 'snapshot') return service.snapshot(data.token, data.conversationId);
  if (op === 'drain') { const relay = new domain.OutboxRelay(service, broker, stats); let count = 0; while (count < 100 && await relay.runOnce()) count++; return count; }
  if (op === 'consume') { for (const subscription of ['fanout', 'notification']) { const consumer = new domain.EventConsumer(service, broker, subscription, stats); consumers.push(consumer); await consumer.start(); } return true; }
  if (op === 'stop-consumers') { for (const consumer of consumers.splice(0)) await consumer.stop(); return true; }
  if (op === 'stats') return { effects: stats.effects, duplicates: stats.duplicates };
  if (op === 'hold-claim' || op === 'hold-confirm') {
    const relay = new domain.OutboxRelay(service, broker), row = await relay.claim(); if (!row) throw new Error('Missing claim');
    if (op === 'hold-confirm') { const event = await db.collection('conversationEvents').findOne({ _id: row.eventId }); await broker.publish(broker.prefix, '', Buffer.from(JSON.stringify(domain.eventReference(event))), { messageId: event._id }); }
    await barrier(id, { eventId: row.eventId, leaseUntil: row.leaseUntil.toISOString() });
    await relay.complete(row); return true;
  }
  if (op === 'hold-effect') {
    const channel = await broker.channel(), message = await channel.get(broker.queue('fanout'), { noAck: false }); if (!message) throw new Error('Missing delivery');
    const reference = JSON.parse(message.content.toString('utf8'));
    await new domain.EventConsumer(service, broker, 'fanout').apply(reference);
    await barrier(id, { eventId: reference.eventId }); channel.ack(message); return true;
  }
  if (op === 'call-start') return new domain.CallService(auth).start(data.token, data.command);
  if (op === 'call-worker' || op === 'hold-call') {
    const worker = new domain.CallWorker(new domain.CallService(auth), op === 'hold-call' ? async () => barrier(id, { providerCreated: true }) : undefined);
    return worker.runOnce();
  }
  if (op === 'close') { await close(); return true; }
  throw new Error('Unknown upgrade operation');
}
process.on('message', message => {
  if (!message || JSON.stringify(message).length > 65536) return;
  if (message.op === 'release') { held?.(); return; }
  queue = queue.then(async () => {
    try { const result = await operation(message.id, message.op, message.data ?? {}); send({ kind: 'result', id: message.id, result }); }
    catch (error) { send({ kind: 'result', id: message.id, error: { status: error?.status ?? 500, code: /lease/i.test(error?.message ?? '') ? 'LEASE_LOST' : error?.code ?? 'OPERATION_FAILED' } }); }
    if (message.op === 'close') process.disconnect();
  });
});
process.once('disconnect', () => { void close().finally(() => process.exit()); });
setTimeout(() => process.exit(75), 600000).unref();
const commit = directory === root ? execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim() : JSON.parse(await readFile(join(directory, 'upgrade-artifact.json'), 'utf8')).commit;
send({ kind: 'ready', modulePath, commit, domainSha256: createHash('sha256').update(await readFile(modulePath)).digest('hex') });
