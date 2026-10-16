import { randomUUID } from 'node:crypto';
import { loadConfig } from '@chat/config';
import { loginSchema, registerSchema } from '@chat/contracts';
import { AuthService, MessageService, createMongoClient, runMigrations, unseal, BrokerTransport } from '@chat/domain';
import type { EmailJobRecord, UserRecord, OutboxRecord } from '@chat/domain';
export async function messagingFixture(prefix: string, overrides: Record<string, string> = {}) {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: `${prefix}_${randomUUID().replaceAll('-', '')}`, BROKER_RETRY_BASE_MS: '100', BROKER_RETRY_ATTEMPTS: '2', ...overrides });
  const client = createMongoClient(config), db = client.db(config.MONGODB_DATABASE), auth = new AuthService(config, client, db), service = new MessageService(auth);
  await client.connect(); await runMigrations(db); await auth.initialize();
  const user = async (label: string, verified = true) => {
    const username = `${label}_${randomUUID().slice(0, 8)}`, password = 'Synthetic-messaging-password-123';
    const input = registerSchema.parse({ username, email: `${username}@example.test`, displayName: label, password }); await auth.register(input);
    const stored = await db.collection<UserRecord>('users').findOne({ usernameCanonical: username });
    if (verified) {
      const job = await db.collection<EmailJobRecord>('authEmailJobs').findOne({ userId: stored!._id });
      const payload = JSON.parse(unseal(job!.encryptedPayload!, config.AUTH_EMAIL_KEY)) as { text: string };
      await auth.consumeToken(payload.text.match(/\/verify#token=([A-Za-z0-9_-]{43})/)![1]!, 'verify');
    }
    const signed = await auth.login(loginSchema.parse({ email: input.email, password })); return { id: stored!._id, token: signed.token, csrf: signed.session.csrfToken, email: input.email };
  };
  return { config, client, db, auth, service, user, async close() { await auth.close(); await db.dropDatabase(); await client.close(); } };
}
export function command(conversationId: string, text = 'A real durable message') { return { v: 1 as const, conversationId, clientMessageId: randomUUID(), text, attachmentIds: [] }; }
export async function expireClaims(f: Awaited<ReturnType<typeof messagingFixture>>) {
  await f.db.collection<OutboxRecord>('outbox').updateMany({ status: { $in: ['pending', 'claimed'] } }, { $set: { leaseUntil: new Date(0), availableAt: new Date(0) } });
}
export async function waitFor(check: () => Promise<boolean>, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for durable delivery evidence');
}
export async function cleanBroker(f: Awaited<ReturnType<typeof messagingFixture>>) {
  const broker = await BrokerTransport.open(f.config); try { await broker.deleteTestTopology(); } finally { await broker.close(); }
}
