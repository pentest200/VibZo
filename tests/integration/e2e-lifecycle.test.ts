import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { expect, it } from 'vitest';
import type { Reporter } from '@playwright/test/reporter';
import { createMongoClient, AttachmentStorage } from '@chat/domain';
import { loadConfig } from '@chat/config';
import { claimFixture, cleanupFixture } from '../e2e/lifecycle.js';
import FixtureCleanupReporter from '../e2e/cleanup-reporter.js';
import { browserEndpoints } from '../e2e/endpoints.js';

it('refuses foreign/existing/live browser targets and cleans owned late work after a failed run', async () => {
  const identity = { database: `chat_e2e_auth_${randomUUID().replaceAll('-', '')}`, runId: randomUUID() };
  for (const database of ['chat', 'admin', 'chat_e2e_auth_foreign']) {
    await expect(claimFixture({ ...identity, database })).rejects.toThrow('Invalid isolated');
    await expect(cleanupFixture({ ...identity, database })).rejects.toThrow('Invalid isolated');
  }
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: identity.database });
  const client = createMongoClient(config), storage = new AttachmentStorage(config), server = createServer(socket => socket.destroy());
  const previous = { database: process.env['E2E_DATABASE'], runId: process.env['E2E_RUN_ID'] }; let owned = false;
  try {
    await client.connect(); await claimFixture(identity); owned = true;
    await expect(claimFixture(identity)).rejects.toThrow('already exists');
    await expect(cleanupFixture({ ...identity, runId: randomUUID() })).rejects.toThrow('foreign');
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(browserEndpoints().api, '127.0.0.1', resolve); });
    await expect(cleanupFixture(identity)).rejects.toThrow('servers must stop');
    expect(await client.db(identity.database).collection('e2eFixtureOwner').countDocuments()).toBe(1);
    // A real late write and private object remain until every writer has stopped.
    await client.db(identity.database).collection<{ _id: string; seq: number }>('inboxCounters').insertOne({ _id: randomUUID(), seq: 1 });
    await storage.putApproved(`${identity.database}/cleanup-canary`, Buffer.from('Synthetic cleanup fixture'), 'text/plain');
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    process.env['E2E_DATABASE'] = identity.database; process.env['E2E_RUN_ID'] = identity.runId;
    const reporter: Reporter = new FixtureCleanupReporter();
    await reporter.onEnd?.({ status: 'failed', startTime: new Date(), duration: 0 });
    expect((await client.db('admin').admin().listDatabases()).databases.some(row => row.name === identity.database)).toBe(false);
    expect((await storage.list(config.S3_APPROVED_BUCKET)).Contents ?? []).toHaveLength(0);
    await cleanupFixture(identity); // Cleanup is idempotent when its owned target is gone.
  } finally {
    if (previous.database === undefined) delete process.env['E2E_DATABASE']; else process.env['E2E_DATABASE'] = previous.database;
    if (previous.runId === undefined) delete process.env['E2E_RUN_ID']; else process.env['E2E_RUN_ID'] = previous.runId;
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    try { if (owned) await cleanupFixture(identity); } finally { storage.close(); await client.close(); }
  }
});
