import { createServer, connect } from 'node:net';
import type { Socket as TcpSocket } from 'node:net';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { createClient } from 'redis';
import { createGateway } from '@chat/gateway';
import { SyncService, FanoutWorker, syncChannel, eventReference } from '@chat/domain';
import type { ControlEvent, SessionRecord, ProjectionJob } from '@chat/domain';
import { messagingFixture, command, waitFor } from './messaging-fixture.js';
let f: Awaited<ReturnType<typeof messagingFixture>>, gateway: Awaited<ReturnType<typeof createGateway>>, sync: SyncService, redis: ReturnType<typeof createClient>;
const sockets: Socket[] = [];
beforeEach(async () => { f = await messagingFixture('gateway_test'); sync = new SyncService(f.auth); redis = createClient({ url: f.config.REDIS_URL }); redis.on('error', () => {}); await redis.connect(); });
afterEach(async () => { for (const socket of sockets.splice(0)) socket.disconnect(); if (gateway) await gateway.close(); if (redis?.isOpen) await redis.close(); if (f) await f.close(); });
async function socket(url: string, actor: Awaited<ReturnType<typeof f.user>>, acknowledge = true) {
  const client = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { Origin: f.config.WEB_ORIGIN, Cookie: `commonroom_session=${actor.token}` }, auth: { csrf: actor.csrf } }); sockets.push(client);
  if (acknowledge) client.on('sync:hint', (_hint, ack: () => void) => ack());
  await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); }); return client;
}
async function reference(id: string) { return eventReference((await f.db.collection<ControlEvent>('conversationEvents').findOne({ _id: id }))!); }
it('disconnects a slow consumer when its unacknowledged hint budget is exhausted', async () => {
  gateway = await createGateway({ ...f.config, MAX_LIVE_BUFFER_EVENTS: 2 }, 0);
  const actor = await f.user('slow'), id = (await sync.createGroup(actor.token, randomUUID(), 'Slow consumer')).conversationId, client = await socket(gateway.url, actor, false);
  await client.timeout(5000).emitWithAck('sync:subscribe', { conversationId: id }); let received = 0; client.on('sync:hint', () => { received++; });
  for (let index = 0; index < 3; index++) { const sent = await sync.send(actor.token, command(id, `Bounded ${index}`)); await redis.publish(syncChannel(f.config), JSON.stringify(await reference(sent.eventId))); if (index < 2) await waitFor(async () => received === index + 1); }
  await waitFor(async () => !client.connected, 4000); expect(received).toBe(2);
  expect((await sync.snapshot(actor.token, id)).messages).toHaveLength(3);
});
it('rejects forged canonical references and tolerates duplicate and reversed hints without changing durable truth', async () => {
  gateway = await createGateway(f.config, 0); const actor = await f.user('order'), id = (await sync.createGroup(actor.token, randomUUID(), 'Ordering')).conversationId, client = await socket(gateway.url, actor);
  await client.timeout(5000).emitWithAck('sync:subscribe', { conversationId: id }); const first = await sync.send(actor.token, command(id, 'First')), second = await sync.send(actor.token, command(id, 'Second'));
  let received = 0; client.on('sync:hint', () => { received++; });
  await redis.publish(syncChannel(f.config), JSON.stringify({ ...await reference(first.eventId), sequence: '99999' }));
  // A forged hint cannot advance a client cursor; only a later authorized snapshot carries state and its watermark.
  await redis.publish(syncChannel(f.config), JSON.stringify(await reference(second.eventId))); await waitFor(async () => received === 1);
  await redis.publish(syncChannel(f.config), JSON.stringify(await reference(second.eventId)));
  await redis.del(`${syncChannel(f.config)}:dispatch:${first.eventId}`); await redis.publish(syncChannel(f.config), JSON.stringify(await reference(first.eventId))); await waitFor(async () => received === 2);
  const snapshot = await sync.snapshot(actor.token, id); expect(snapshot.messages.map(row => row.text)).toEqual(['Second', 'First']); expect(snapshot.watermark).toBe(second.message.creationSequence);
});
it('rejects commands from an expired connected session within the authoritative recheck bound', async () => {
  gateway = await createGateway({ ...f.config, SESSION_RECHECK_SECONDS: 1 }, 0); const actor = await f.user('expiry'), client = await socket(gateway.url, actor);
  await f.db.collection<SessionRecord>('sessions').updateMany({ userId: actor.id }, { $set: { expiresAt: new Date(0) } });
  expect(await client.timeout(3000).emitWithAck('sync:subscribe', { conversationId: randomUUID() })).toEqual({ ok: false }); await waitFor(async () => !client.connected, 4000);
});
it('fails readiness and disconnects active sockets when the real Redis connection is severed', async () => {
  const destination = new URL(f.config.REDIS_URL), connections = new Set<TcpSocket>();
  const proxy = createServer(incoming => { const outgoing = connect(Number(destination.port || 6379), destination.hostname); for (const stream of [incoming, outgoing]) { connections.add(stream); stream.on('error', () => {}); stream.on('close', () => connections.delete(stream)); } incoming.pipe(outgoing); outgoing.pipe(incoming); });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve)); const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('Proxy address missing');
  try {
    const proxied = new URL(f.config.REDIS_URL); proxied.hostname = '127.0.0.1'; proxied.port = String(address.port);
    gateway = await createGateway({ ...f.config, SESSION_RECHECK_SECONDS: 1, REDIS_URL: proxied.toString() }, 0);
    const actor = await f.user('redisfault'), client = await socket(gateway.url, actor);
    const closed = new Promise<void>(resolve => proxy.close(() => resolve())); for (const stream of connections) stream.destroy(); await closed;
    await waitFor(async () => !client.connected, 5000); expect((await fetch(`${gateway.url}/health/ready`)).status).toBe(503);
    expect((await fetch(`${gateway.url}/health/live`)).status).toBe(200);
  } finally { for (const stream of connections) stream.destroy(); if (proxy.listening) await new Promise<void>(resolve => proxy.close(() => resolve())); }
});
it('runs a separate gateway process, restarts it and recovers missing activity through Mongo replay', async () => {
  gateway = await createGateway(f.config, 0); const actor = await f.user('restart'), id = (await sync.createGroup(actor.token, randomUUID(), 'Restart')).conversationId;
  const reserve = createServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve)); const address = reserve.address(); if (!address || typeof address === 'string') throw new Error('Port missing'); await new Promise<void>(resolve => reserve.close(() => resolve()));
  const url = `http://127.0.0.1:${address.port}`;
  const start = async () => { const child = spawn(process.execPath, ['apps/gateway/dist/main.js'], { env: { ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: f.config.MONGODB_DATABASE, GATEWAY_PORT: String(address.port) }, stdio: 'ignore', windowsHide: true }); await waitFor(async () => { try { return (await fetch(`${url}/health/ready`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }); return child; };
  let child = await start();
  try { const remote = await socket(url, actor), local = await socket(gateway.url, actor); await remote.timeout(3000).emitWithAck('sync:subscribe', { conversationId: id }); await local.timeout(3000).emitWithAck('sync:subscribe', { conversationId: id });
    let remoteHint = false, localHint = false; remote.on('sync:hint', hint => { if (hint.conversationId === id) remoteHint = true; }); local.on('sync:hint', hint => { if (hint.conversationId === id) localHint = true; });
    const beforeRestart = await sync.send(actor.token, command(id, 'Across separate gateway processes')); await redis.publish(syncChannel(f.config), JSON.stringify(await reference(beforeRestart.eventId))); await waitFor(async () => remoteHint && localHint);
    const old = await sync.snapshot(actor.token, id); const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await exited; await waitFor(async () => !remote.connected);
    const sent = await sync.send(actor.token, command(id, 'While gateway was down')); child = await start(); const recovered = await socket(url, actor); expect((await recovered.timeout(3000).emitWithAck('sync:subscribe', { conversationId: id })).ok).toBe(true);
    expect((await sync.replay(actor.token, id, old.watermark)).events.map(row => row.eventId)).toContain(sent.eventId);
    expect((await sync.snapshot(actor.token, id)).messages[0]!.text).toBe('While gateway was down'); expect(local.connected).toBe(true);
  } finally { const exited = new Promise<void>(resolve => child.once('exit', () => resolve())); child.kill(); await exited; }
});
it('gracefully drains sockets and releases connection leases while durable writes remain independent', async () => {
  gateway = await createGateway(f.config, 0); const actor = await f.user('drain'), id = (await sync.createGroup(actor.token, randomUUID(), 'Drain')).conversationId, client = await socket(gateway.url, actor);
  const session = (await f.auth.authenticate(actor.token)).session, key = `${syncChannel(f.config)}:connections:${session._id}`;
  expect(await redis.zCard(key)).toBe(1); let warned = false; client.once('sync:reconnect', () => { warned = true; });
  await gateway.close(); await waitFor(async () => !client.connected); expect(warned).toBe(true); expect(await redis.zCard(key)).toBe(0);
  await sync.send(actor.token, command(id, 'Accepted after gateway drain')); expect((await sync.snapshot(actor.token, id)).messages[0]!.text).toBe('Accepted after gateway drain');
});
it('retains failed fanout jobs and reclaims expired owners before publishing to real Redis', async () => {
  const actor = await f.user('fanoutlease'), id = (await sync.createGroup(actor.token, randomUUID(), 'Fanout lease')).conversationId, sent = await sync.send(actor.token, command(id));
  const canonical = (await f.db.collection<ControlEvent>('conversationEvents').findOne({ _id: sent.eventId }))!, jobs = f.db.collection<ProjectionJob>('fanoutJobs'), fanout = new FanoutWorker(f.db, f.config);
  await jobs.insertOne({ _id: sent.eventId, schemaVersion: 1, eventId: sent.eventId, conversationId: id, sequence: canonical.sequence, state: 'claimed', leaseOwner: 'stale-fixture-owner', leaseUntil: new Date(0), createdAt: new Date() });
  try {
    await f.db.collection<ControlEvent>('conversationEvents').deleteOne({ _id: sent.eventId }); await expect(fanout.runOnce()).rejects.toThrow('delayed');
    expect(await jobs.findOne({ _id: sent.eventId })).toMatchObject({ state: 'pending', leaseOwner: null });
    await f.db.collection<ControlEvent>('conversationEvents').insertOne(canonical); await jobs.updateOne({ _id: sent.eventId }, { $set: { state: 'claimed', leaseOwner: 'second-stale-owner', leaseUntil: new Date(0) } });
    expect(await fanout.runOnce()).toBe(true); expect(await jobs.findOne({ _id: sent.eventId })).toMatchObject({ state: 'published', leaseOwner: null, publishedAt: expect.any(Date) });
  } finally { await fanout.close(); }
});
