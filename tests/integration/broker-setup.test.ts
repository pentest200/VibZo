import { createServer, connect as tcpConnect } from 'node:net';
import type { Socket } from 'node:net';
import { randomUUID } from 'node:crypto';
import { connect } from 'amqplib';
import { afterEach, expect, it } from 'vitest';
import { loadConfig } from '@chat/config';
import { BrokerTransport, BrokerUnavailable, createMongoClient } from '@chat/domain';
import { messagingFixture, openFixtureBroker, cleanupSteps } from './messaging-fixture.js';
import { faultProxy, through } from './telemetry-fixture.js';

const disposals: (() => Promise<unknown>)[] = [];
afterEach(async () => { await cleanupSteps(disposals.splice(0).reverse()); });
function configuration() {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: `broker_setup_${randomUUID().replaceAll('-', '')}`, BROKER_RETRY_BASE_MS: '100', BROKER_RETRY_ATTEMPTS: '2' });
  disposals.push(() => BrokerTransport.cleanTestTopology(config)); return config;
}
async function gate(target: string, refuseFirst: boolean) {
  const url = new URL(target), sockets = new Set<Socket>(); let attempts = 0;
  const server = createServer(incoming => {
    attempts++; incoming.on('error', () => {});
    if (refuseFirst && attempts === 1) { incoming.destroy(); return; }
    const outgoing = tcpConnect(Number(url.port || 5672), url.hostname);
    for (const socket of [incoming, outgoing]) { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); }
    incoming.once('close', () => outgoing.destroy()); outgoing.once('close', () => incoming.destroy()); incoming.pipe(outgoing); outgoing.pipe(incoming);
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Gate port missing');
  disposals.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(done => server.close(() => done())); });
  return { port: address.port, attempts: () => attempts };
}
it('recovers a real interrupted setup handshake before creating canonical quorum topology', async () => {
  const config = configuration(), proxy = await gate(config.RABBITMQ_URL, true);
  const broker = await openFixtureBroker({ ...config, RABBITMQ_URL: through(config.RABBITMQ_URL, proxy.port) });
  disposals.push(() => broker.close());
  expect(proxy.attempts()).toBe(2);
  const channel = await broker.channel(); expect((await channel.checkQueue(broker.queue('fanout'))).queue).toBe(broker.queue('fanout'));
  await broker.releaseChannel(channel);
});
it('fails authentication immediately and exposes only safe diagnostics', async () => {
  const config = configuration(), proxy = await gate(config.RABBITMQ_URL, false), target = new URL(through(config.RABBITMQ_URL, proxy.port));
  const secret = `secret-${randomUUID()}`; target.username = `absent_${randomUUID()}`; target.password = secret;
  const error: unknown = await openFixtureBroker({ ...config, RABBITMQ_URL: target.toString() }).catch(error => error);
  expect(error).toBeInstanceOf(BrokerUnavailable); expect(error).toMatchObject({ diagnostic: { stage: 'connect', reason: 'access_refused', replyCode: 403 } });
  expect(proxy.attempts()).toBe(1);
  expect(String((error as Error).stack) + JSON.stringify(error)).not.toContain(secret);
  expect(String((error as Error).stack) + JSON.stringify(error)).not.toContain(target.username);
});
it('does not retry incompatible queues and removes partial topology without redeclaring it', async () => {
  const config = configuration(), prefix = `${config.BROKER_NAMESPACE}.${config.MONGODB_DATABASE}`;
  const raw = await connect(config.RABBITMQ_URL, { timeout: config.DEPENDENCY_TIMEOUT_MS }); disposals.push(() => raw.close());
  const channel = await raw.createChannel();
  await channel.assertExchange(prefix, 'fanout', { durable: true });
  await channel.assertQueue(`${prefix}.fanout`, { durable: true }); // Deliberate classic/quorum incompatibility.
  await expect(openFixtureBroker(config)).rejects.toMatchObject({ diagnostic: { stage: 'topology', reason: 'precondition_failed', replyCode: 406 } });
  await BrokerTransport.cleanTestTopology(config);
  const recovered = await BrokerTransport.open(config); disposals.push(() => recovered.close());
  const verified = await recovered.channel(); expect((await verified.checkQueue(recovered.queue('fanout'))).queue).toBe(recovered.queue('fanout'));
  await recovered.releaseChannel(verified);
});
it('still drops the owned database and closes proxies when broker cleanup cannot connect', async () => {
  const f = await messagingFixture('broker_cleanup'), proxy = await faultProxy('127.0.0.1', Number(new URL(f.config.RABBITMQ_URL).port || 5672));
  let databaseClosed = false, proxyClosed = false;
  const closeDb = async () => { if (!databaseClosed) { databaseClosed = true; await f.close(); } };
  const closeProxy = async () => { if (!proxyClosed) { proxyClosed = true; await proxy.close(); } };
  disposals.push(closeDb, closeProxy); proxy.setBlocked(true);
  await expect(cleanupSteps([
    () => BrokerTransport.cleanTestTopology({ ...f.config, RABBITMQ_URL: through(f.config.RABBITMQ_URL, proxy.port), DEPENDENCY_TIMEOUT_MS: 200 }),
    closeDb, closeProxy,
  ])).rejects.toBeInstanceOf(AggregateError);
  expect(databaseClosed).toBe(true); expect(proxyClosed).toBe(true);
  const reader = createMongoClient(f.config);
  try { await reader.connect(); expect((await reader.db('admin').admin().listDatabases()).databases.some(row => row.name === f.config.MONGODB_DATABASE)).toBe(false); }
  finally { await reader.close(); }
});
it('refuses ordinary/production topology cleanup before connecting', async () => {
  const config = loadConfig();
  await expect(BrokerTransport.cleanTestTopology({ ...config, NODE_ENV: 'test', MONGODB_DATABASE: 'chat', RABBITMQ_URL: 'amqp://127.0.0.1:1' })).rejects.toThrow('isolated');
  await expect(BrokerTransport.cleanTestTopology({ ...config, NODE_ENV: 'production', MONGODB_DATABASE: `broker_setup_${'a'.repeat(32)}`, RABBITMQ_URL: 'amqp://127.0.0.1:1' })).rejects.toThrow('isolated');
});
