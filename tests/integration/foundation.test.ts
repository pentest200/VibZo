import { randomUUID } from 'node:crypto';
import { connect as connectTcp } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '@chat/config';
import { createMongoClient, inspectMongo, sequenceToLong, transactionOptions } from '@chat/domain';
import { createApi } from '@chat/api';
import { createClient } from 'redis';
import { connect } from 'amqplib';
import { S3Client, HeadBucketCommand, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const config = loadConfig();
const mongo = createMongoClient(config);
const database = mongo.db(`foundation_test_${randomUUID().replaceAll('-', '')}`);
beforeAll(async () => { await mongo.connect(); });
afterAll(async () => {
  try { if (await inspectMongo(mongo)) await database.dropDatabase(); }
  finally { await mongo.close(); }
});
describe('real replica-set foundation (missing services FAIL, never skip)', () => {
  it('requires a writable replica primary and commit/rollback across collections', async () => {
    expect(await inspectMongo(mongo)).toBe(true);
    await database.createCollection('messages');
    await database.createCollection('outbox');
    const session = mongo.startSession();
    try {
      await session.withTransaction(async () => {
        await database.collection('messages').insertOne({ commandId: 'commit', sequence: sequenceToLong('9007199254740993') }, { session });
        await database.collection('outbox').insertOne({ commandId: 'commit' }, { session });
      }, { ...transactionOptions, timeoutMS: 10000 });
      expect(await database.collection('messages').countDocuments({ commandId: 'commit' })).toBe(1);
      expect(await database.collection('outbox').countDocuments({ commandId: 'commit' })).toBe(1);
      const saved = await database.collection('messages').findOne({ commandId: 'commit' });
      expect(saved?.['sequence'].toString()).toBe('9007199254740993');
      await expect(session.withTransaction(async () => {
        await database.collection('messages').insertOne({ commandId: 'abort' }, { session });
        await database.collection('outbox').insertOne({ commandId: 'abort' }, { session });
        throw new Error('injected precommit failure');
      }, { ...transactionOptions, timeoutMS: 10000 })).rejects.toThrow('injected');
      expect(await database.collection('messages').countDocuments({ commandId: 'abort' })).toBe(0);
      expect(await database.collection('outbox').countDocuments({ commandId: 'abort' })).toBe(0);
    } finally { await session.endSession(); }
  });
  it('serves real positive API readiness against the replica set', async () => {
    const api = await createApi(config);
    try {
      await api.app.listen(0, '127.0.0.1');
      const response = await fetch(`${await api.app.getUrl()}/health/ready`);
      expect(response.status).toBe(200);
      expect((await response.json() as { status: string }).status).toBe('ready');
    } finally { await api.close(); }
  });
});
it('authenticates Redis and demonstrates ephemeral TTL', async () => {
  const redis = createClient({ url: config.REDIS_URL, socket: { connectTimeout: 3000, reconnectStrategy: false } });
  redis.on('error', () => { /* connection failure is asserted by connect() */ });
  try {
    await redis.connect(); expect(await redis.ping()).toBe('PONG');
    const key = `foundation:${randomUUID()}`;
    await redis.set(key, 'test', { EX: 30 }); expect(await redis.ttl(key)).toBeGreaterThan(0); await redis.del(key);
  } finally { if (redis.isOpen) await redis.quit(); }
});
it('confirms durable persistent broker publication and manually ACKs independent subscriptions', async () => {
  const connection = await connect(config.RABBITMQ_URL, { timeout: 3000 });
  const channel = await connection.createConfirmChannel();
  const prefix = `foundation.${randomUUID()}`;
  try {
    await channel.prefetch(config.BROKER_PREFETCH);
    await channel.assertExchange(prefix, 'fanout', { durable: true });
    for (const sideEffect of ['fanout', 'notification', 'media']) {
      await channel.assertQueue(`${prefix}.${sideEffect}`, { durable: true, arguments: { 'x-queue-type': 'quorum' } });
      await channel.bindQueue(`${prefix}.${sideEffect}`, prefix, '');
    }
    channel.publish(prefix, '', Buffer.from('foundation-confirm'), { persistent: true, messageId: randomUUID() });
    await channel.waitForConfirms();
    for (const sideEffect of ['fanout', 'notification', 'media']) {
      const message = await channel.get(`${prefix}.${sideEffect}`, { noAck: false });
      expect(message).not.toBe(false);
      if (message) { expect(message.content.toString()).toBe('foundation-confirm'); channel.ack(message); }
      await channel.deleteQueue(`${prefix}.${sideEffect}`);
    }
    await channel.deleteExchange(prefix);
  } finally { await channel.close(); await connection.close(); }
});
it('reads/writes two private S3 areas and rejects unauthenticated object access', async () => {
  const s3 = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY }, maxAttempts: 1,
    requestHandler: { connectionTimeout: 3000, requestTimeout: 5000 } });
  try {
    for (const bucket of [config.S3_QUARANTINE_BUCKET, config.S3_APPROVED_BUCKET]) {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      const key = `foundation/${randomUUID()}`;
      try {
        await s3.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'private foundation test', ContentType: 'text/plain' }));
        const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        expect(await object.Body?.transformToString()).toBe('private foundation test');
        const unauthenticated = await fetch(`${config.S3_ENDPOINT}/${bucket}/${key}`, { signal: AbortSignal.timeout(5000) });
        expect([401, 403]).toContain(unauthenticated.status);
      } finally { await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); }
    }
  } finally { s3.destroy(); }
});
it('reaches Mailpit HTTP and receives an actual SMTP greeting', async () => {
  const response = await fetch('http://127.0.0.1:8025/readyz', { signal: AbortSignal.timeout(3000) });
  expect(response.ok).toBe(true);
  const greeting = await new Promise<string>((resolve, reject) => {
    const socket = connectTcp({ host: config.SMTP_HOST, port: config.SMTP_PORT });
    socket.setTimeout(3000, () => { socket.destroy(); reject(new Error('SMTP timeout')); });
    socket.once('error', reject);
    socket.once('data', data => { socket.end('QUIT\r\n'); resolve(data.toString()); });
  });
  expect(greeting).toMatch(/^220 /);
});
