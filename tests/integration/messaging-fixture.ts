import { randomUUID } from 'node:crypto';
import { loadConfig } from '@chat/config';
import type { Config } from '@chat/config';
import { loginSchema, registerSchema } from '@chat/contracts';
import { AuthService, MessageService, createMongoClient, runMigrations, unseal, BrokerTransport, BrokerUnavailable } from '@chat/domain';
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
  return { config, client, db, auth, service, user, async close() { try { await auth.close(); } finally { try { await db.dropDatabase(); } finally { await client.close(); } } } };
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
  await BrokerTransport.cleanTestTopology(f.config);
}
export async function openFixtureBroker(config: Config) {
  if (config.NODE_ENV !== 'test' || !/_[a-f0-9]{32}$/.test(config.MONGODB_DATABASE)) throw new Error('Broker readiness requires an isolated test namespace');
  // Setup only. Keep production connection deadlines and outage assertions intact.
  // Permanent authentication/topology errors fail immediately, never get retried.
  for (let attempt = 1; ; attempt++) {
    try { return await BrokerTransport.open(config); }
    catch (error) {
      if (!(error instanceof BrokerUnavailable) || error.diagnostic?.stage !== 'connect' || !['timeout', 'connection_refused', 'connection_closed'].includes(error.diagnostic.reason) || attempt >= 5) throw error;
      console.info('Fixture broker connection not ready', { attempt, ...error.diagnostic });
      await new Promise(resolve => setTimeout(resolve, Math.min(1000, 100 * 2 ** (attempt - 1))));
    }
  }
}
export async function cleanupSteps(steps: (() => Promise<unknown>)[]) {
  const errors: unknown[] = [];
  for (const step of steps) try { await step(); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'Fixture cleanup incomplete; all cleanup steps were attempted');
}
