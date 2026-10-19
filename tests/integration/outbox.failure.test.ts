import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { AuthService, MessageService, BrokerTransport, EventConsumer, OutboxRelay, DeliveryStats, eventReference, replayDeadLetters } from '@chat/domain';
import type { ControlEvent, OutboxRecord, UserRecord } from '@chat/domain';
import { messagingFixture, command, cleanBroker, expireClaims, waitFor } from './messaging-fixture.js';
const execute = promisify(execFile);
let f: Awaited<ReturnType<typeof messagingFixture>>, broker: BrokerTransport, relay: OutboxRelay, stats: DeliveryStats, owner: Awaited<ReturnType<Awaited<ReturnType<typeof messagingFixture>>['user']>>, id: string;
let consumers: EventConsumer[] = [];
beforeEach(async () => { f = await messagingFixture('delivery_test', { BROKER_RETRY_BASE_MS: '500' }); broker = await BrokerTransport.open(f.config); stats = new DeliveryStats(); relay = new OutboxRelay(f.service, broker, stats); owner = await f.user('delivery'); id = (await f.service.createGroup(owner.token, randomUUID(), 'Delivery test')).conversationId; });
afterEach(async () => { for (const consumer of consumers) await consumer.stop(); consumers = []; if (broker) await broker.close(); if (f) { await cleanBroker(f); await f.close(); } });
async function start() { consumers = ['fanout', 'notification'].map(subscription => new EventConsumer(f.service, broker, subscription as 'fanout' | 'notification', stats)); for (const consumer of consumers) await consumer.start(); }
async function drain() { while (await relay.runOnce()) { /* bounded test fixtures only */ } }
async function reference() { return eventReference((await f.db.collection<ControlEvent>('conversationEvents').findOne({ conversationId: id }))!); }
it('confirms publication, commits independent effects/jobs before ACK and deduplicates repeated deliveries', async () => {
  const accepted = await f.service.send(owner.token, command(id)); await start(); await drain();
  await waitFor(async () => await f.db.collection('consumerEffects').countDocuments({}) === 4);
  expect(await f.db.collection('fanoutJobs').countDocuments({})).toBe(2); expect(await f.db.collection('notificationJobs').countDocuments({})).toBe(1);
  const ref = eventReference((await f.db.collection<ControlEvent>('conversationEvents').findOne({ _id: accepted.eventId }))!);
  await broker.publish(broker.prefix, '', Buffer.from(JSON.stringify(ref)), { messageId: ref.eventId });
  await waitFor(async () => stats.duplicates >= 2); expect(await f.db.collection('consumerEffects').countDocuments({})).toBe(4);
  expect(await f.db.collection('fanoutJobs').countDocuments({})).toBe(2); expect(await f.db.collection('outbox').countDocuments({ status: 'published' })).toBe(2);
});
it('survives actual process exit after publish confirm before mark, reclaims lease and applies each local effect once', async () => {
  await expect(execute(process.execPath, ['--import', 'tsx', 'tests/fixtures/outbox-crash.ts'], { env: { ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: f.config.MONGODB_DATABASE, BROKER_RETRY_BASE_MS: String(f.config.BROKER_RETRY_BASE_MS), BROKER_RETRY_ATTEMPTS: '2' }, timeout: 20000 })).rejects.toMatchObject({ code: 73 });
  const row = await f.db.collection<OutboxRecord>('outbox').findOne({ status: 'claimed' }); expect(row).not.toBeNull();
  await expireClaims(f); await start(); await drain();
  await waitFor(async () => await f.db.collection('consumerEffects').countDocuments({}) === 2 && stats.duplicates >= 2);
  expect(await f.db.collection('fanoutJobs').countDocuments({})).toBe(1);
  expect((await f.db.collection<OutboxRecord>('outbox').findOne({ _id: row!._id }))?.attempts).toBe(2);
});
it('fences stale relay owners and retains admission until confirmed publication completion', async () => {
  const stale = await relay.claim(); expect(stale).not.toBeNull(); await expireClaims(f); const current = await relay.claim(); expect(current!.leaseOwner).not.toBe(stale!.leaseOwner);
  await expect(relay.complete(stale!)).rejects.toThrow('lease'); expect(await f.db.collection('outbox').countDocuments({ status: 'claimed' })).toBe(1);
  const ref = await reference(); await broker.publish(broker.prefix, '', Buffer.from(JSON.stringify(ref)), { messageId: ref.eventId }); await relay.complete(current!);
  expect(await f.db.collection('outbox').countDocuments({ status: 'published' })).toBe(1);
});
it('rejects mandatory unroutable publication without falsely completing an outbox record', async () => {
  await expect(broker.publish(`${broker.prefix}.resume`, 'missing-route', Buffer.from('{}'))).rejects.toThrow();
  expect(await f.db.collection('outbox').countDocuments({ status: 'pending' })).toBe(1);
});
it('routes malformed and forged event references to independent DLQs without effects', async () => {
  await start(); const invalid = { ...(await reference()), v: 99 };
  await broker.publish(broker.prefix, '', Buffer.from(JSON.stringify(invalid)), { messageId: randomUUID() });
  const forged = { ...(await reference()), sequence: '999' }; await broker.publish(broker.prefix, '', Buffer.from(JSON.stringify(forged)), { messageId: forged.eventId });
  await waitFor(async () => stats.dead === 4); expect(await f.db.collection('consumerEffects').countDocuments({})).toBe(0);
  const channel = await broker.channel(); expect((await channel.checkQueue(`${broker.queue('fanout')}.dead`)).messageCount).toBe(2); expect((await channel.checkQueue(`${broker.queue('notification')}.dead`)).messageCount).toBe(2);
  const expired = await reference(); await f.db.collection<ControlEvent>('conversationEvents').updateOne({ _id: expired.eventId }, { $set: { createdAt: new Date(0) } });
  await broker.publish(broker.prefix, '', Buffer.from(JSON.stringify(expired)), { messageId: expired.eventId });
  await waitFor(async () => stats.dead === 6); expect(await f.db.collection('consumerEffects').countDocuments({})).toBe(0);
});
it('recovers a transient effect failure through a confirmed TTL retry without duplicate local work', async () => {
  const info = await f.db.listCollections({ name: 'fanoutJobs' }).next();
  const validator = info && 'options' in info ? info.options?.validator : undefined;
  await f.db.command({ collMod: 'fanoutJobs', validator: { $jsonSchema: { required: ['testOnlyImpossibleField'] } } });
  await start(); await drain(); await waitFor(async () => stats.retries >= 1);
  await f.db.command({ collMod: 'fanoutJobs', validator });
  await waitFor(async () => await f.db.collection('fanoutJobs').countDocuments({}) === 1);
  expect(await f.db.collection('consumerEffects').countDocuments({ subscription: 'fanout' })).toBe(1); expect(stats.dead).toBe(0);
});
it('rolls back marker/effect together, retries through actual TTL queues and dead-letters bounded exhaustion', async () => {
  // A validator fault rejects only the projection insert, after marker insertion in the same transaction.
  await f.db.command({ collMod: 'fanoutJobs', validator: { $jsonSchema: { required: ['testOnlyImpossibleField'] } } });
  await start(); await drain(); await waitFor(async () => stats.dead === 1);
  expect(stats.retries).toBe(2); expect(await f.db.collection('consumerEffects').countDocuments({ subscription: 'fanout' })).toBe(0);
  expect(await f.db.collection('fanoutJobs').countDocuments({})).toBe(0); expect(await f.db.collection('consumerEffects').countDocuments({ subscription: 'notification' })).toBe(1);
  const channel = await broker.channel(); expect((await channel.checkQueue(`${broker.queue('fanout')}.dead`)).messageCount).toBe(1);
});
it('requeues an unacknowledged delivery after actual effect commit and avoids duplicating its job', async () => {
  await drain(); const channel = await broker.channel(), message = await channel.get(broker.queue('fanout'), { noAck: false }); expect(message).not.toBe(false);
  if (!message) throw new Error('Missing delivery'); const ref = await reference();
  const consumer = new EventConsumer(f.service, broker, 'fanout', stats); expect(await consumer.apply(ref)).toBe(true);
  // Connection loss before ACK is separate from effect commit.
  await broker.close(); broker = await BrokerTransport.open(f.config); relay = new OutboxRelay(f.service, broker, stats); await start();
  await waitFor(async () => stats.duplicates >= 1); expect(await f.db.collection('fanoutJobs').countDocuments({})).toBe(1);
});
it('requires moderator privilege and audits bounded DLQ replay while refusing expired events', async () => {
  const ref = await reference(); await broker.publish(`${broker.prefix}.dead`, 'fanout', Buffer.from(JSON.stringify(ref)), { messageId: ref.eventId });
  await expect(replayDeadLetters(f.service, broker, owner.token, 'fanout', 1)).rejects.toMatchObject({ status: 403 });
  await f.db.collection<UserRecord>('users').updateOne({ _id: owner.id }, { $set: { role: 'moderator' } }); // Test-only privilege fixture.
  // Model the operator CLI's dedicated connection; channel release itself preserves a shared transport.
  const replay = await BrokerTransport.open(f.config);
  try { expect(await replayDeadLetters(f.service, replay, owner.token, 'fanout', 1)).toBe(1); } finally { await replay.close(); }
  expect(await f.db.collection('auditEvents').countDocuments({ action: 'dlq.replay_requested.fanout' })).toBe(1);
  await start(); await waitFor(async () => await f.db.collection('fanoutJobs').countDocuments({}) === 1);
  await f.db.collection<ControlEvent>('conversationEvents').updateOne({ _id: ref.eventId }, { $set: { createdAt: new Date(0) } });
  await broker.publish(`${broker.prefix}.dead`, 'fanout', Buffer.from(JSON.stringify(ref)), { messageId: ref.eventId });
  const expiredReplay = await BrokerTransport.open(f.config);
  try { await expect(replayDeadLetters(f.service, expiredReplay, owner.token, 'fanout', 1)).rejects.toThrow('expired'); } finally { await expiredReplay.close(); }
  expect(await f.db.collection('auditEvents').countDocuments({ action: 'dlq.replay_requested.fanout' })).toBe(1);
});
it('bounds pending projections across concurrent consumers and preserves exhausted work in a DLQ', async () => {
  await f.service.send(owner.token, command(id));
  const bounded = new MessageService(new AuthService({ ...f.config, MAX_PENDING_PROJECTIONS: 1 }, f.client, f.db));
  consumers = [new EventConsumer(bounded, broker, 'fanout', stats), new EventConsumer(bounded, broker, 'fanout', stats)];
  for (const consumer of consumers) await consumer.start(); await drain(); await waitFor(async () => stats.dead === 1);
  expect(await f.db.collection('fanoutJobs').countDocuments({})).toBe(1); expect(await f.db.collection('consumerEffects').countDocuments({ subscription: 'fanout' })).toBe(1);
});
it('retains unpublished work on actual broker queue-limit NACK and recovers after consumers drain', async () => {
  const limited = await messagingFixture('delivery_full', { BROKER_QUEUE_LIMIT: '1' }), transport = await BrokerTransport.open(limited.config), localConsumers: EventConsumer[] = [];
  try {
    const actor = await limited.user('full'), group = (await limited.service.createGroup(actor.token, randomUUID(), 'Full queues')).conversationId;
    const localRelay = new OutboxRelay(limited.service, transport); expect(await localRelay.runOnce()).toBe(true);
    // Quorum reject-publish notifications allow a small in-flight overshoot; do not assume exact max+1 rejection.
    let rejected = false;
    for (let index = 0; index < 10; index++) {
      await limited.service.send(actor.token, command(group, `Queue pressure ${index}`));
      try { await localRelay.runOnce(); } catch { rejected = true; break; }
    }
    expect(rejected).toBe(true);
    expect(await limited.db.collection('outbox').countDocuments({ status: 'pending' })).toBe(1);
    const total = await limited.db.collection('outbox').countDocuments({});
    for (const subscription of ['fanout', 'notification'] as const) { const consumer = new EventConsumer(limited.service, transport, subscription); localConsumers.push(consumer); await consumer.start(); }
    await waitFor(async () => await limited.db.collection('consumerEffects').countDocuments({}) >= (total - 1) * 2);
    await waitFor(async () => { await expireClaims(limited); try { return await localRelay.runOnce(); } catch { return false; } });
    await waitFor(async () => await limited.db.collection('consumerEffects').countDocuments({}) === total * 2);
    expect(await limited.db.collection('outbox').countDocuments({ status: 'published' })).toBe(total);
  } finally { for (const consumer of localConsumers) await consumer.stop(); await transport.close(); await cleanBroker(limited); await limited.close(); }
});
it('keeps durable acceptance during real RabbitMQ outage, enforces cap, and drains after server recovery', async () => {
  await broker.close();
  const docker = ['--config', '.cache/docker', 'compose', '-f', 'infra/compose/compose.yaml'];
  const worker = spawn(process.execPath, ['apps/worker/dist/main.js'], { env: { ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: f.config.MONGODB_DATABASE, WORKER_PORT: '39002', BROKER_RETRY_BASE_MS: '500', BROKER_RETRY_ATTEMPTS: '2' }, stdio: 'ignore', windowsHide: true });
  const workerExit = new Promise<void>(resolve => { worker.once('exit', () => resolve()); });
  try {
    await waitFor(async () => { try { return (await fetch('http://127.0.0.1:39002/health/ready')).status === 200; } catch { return false; } }, 30000);
    await execute('docker', [...docker, 'stop', 'rabbitmq'], { timeout: 30000 });
    await expect(BrokerTransport.open(f.config)).rejects.toThrow('unavailable');
    const mailUser = await f.user('outagemail');
    const mailpitOrigin = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';
    await waitFor(async () => { const response = await fetch(`${mailpitOrigin}/api/v1/search?query=${encodeURIComponent(`to:${mailUser.email}`)}`); return ((await response.json()) as { messages: unknown[] }).messages.length > 0; });
    expect((await fetch('http://127.0.0.1:39002/health/live')).status).toBe(200);
    expect((await fetch('http://127.0.0.1:39002/health/ready')).status).toBe(503);
    // The worker published the initial group before the outage; only the new message now occupies admission.
    const bounded = new MessageService(new AuthService({ ...f.config, MAX_PENDING_OUTBOX: 2 }, f.client, f.db));
    const accepted = await bounded.send(owner.token, command(id, 'Accepted while RabbitMQ is stopped'));
    expect(accepted.status).toBe('accepted'); await bounded.send(owner.token, command(id, 'Second slot'));
    await expect(bounded.send(owner.token, command(id, 'Over budget'))).rejects.toMatchObject({ status: 503 });
    expect(await f.db.collection('messages').countDocuments({ conversationId: id })).toBe(2);
  } finally {
    worker.kill(); await workerExit;
    await execute('docker', [...docker, 'start', 'rabbitmq'], { timeout: 30000 });
    await waitFor(async () => { try { broker = await BrokerTransport.open(f.config); return true; } catch { return false; } }, 60000);
  }
  relay = new OutboxRelay(f.service, broker, stats); await start(); await expireClaims(f); await drain();
  await waitFor(async () => await f.db.collection('consumerEffects').countDocuments({}) === 6);
  expect(await f.db.collection('outbox').countDocuments({ status: { $in: ['pending', 'claimed'] } })).toBe(0);
});
