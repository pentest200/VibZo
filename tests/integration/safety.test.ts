import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { createApi } from '@chat/api';
import { AuthService, AttachmentService, AttachmentWorker, BrokerTransport, EventConsumer, NotificationWorker, SafetyService, SafetyMaintenance, SyncService, GENERIC_PUSH_PAYLOAD, eventReference, runMigrations } from '@chat/domain';
import type { DeletionJob, PushJob, DeviceRecord, UserRecord, AttachmentQuota, ControlEvent, MessageRecord, OutboxRecord, InboxEvent } from '@chat/domain';
import type { DeviceSubscription } from '@chat/contracts';
import { command, messagingFixture } from './messaging-fixture.js';
const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
let f: Awaited<ReturnType<typeof messagingFixture>>, safety: SafetyService, sync: SyncService, broker: BrokerTransport;
const keys = () => { const key = createECDH('prime256v1'); key.generateKeys(); return { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') }; };
const subscription = (): DeviceSubscription => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: keys() });
const execute = promisify(execFile);
beforeAll(async () => {
  f = await messagingFixture('safety_test', { PUSH_ENABLED: 'true', VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: ecdh.getPrivateKey().toString('base64url'), BROKER_NAMESPACE: `safety_${randomUUID().slice(0, 8)}`, MAX_REPORTS_PER_DAY: '2' });
  safety = new SafetyService(f.auth); sync = new SyncService(f.auth); broker = await BrokerTransport.open(f.config);
});
afterAll(async () => { if (broker) { await broker.deleteTestTopology(); await broker.close(); } if (f) await f.close(); });
beforeEach(async () => { if (f) { await f.db.collection('pushJobs').deleteMany({}); await f.db.collection('notificationJobs').deleteMany({}); } });
async function pair(label: string) { const a = await f.user(`${label}a`), b = await f.user(`${label}b`); return { a, b, id: (await sync.createDirect(a.token, b.id)).conversationId }; }
async function intent(id: string, token: string, text = 'Private message that must never enter a push payload') {
  const sent = await sync.send(token, command(id, text));
  const event = await f.db.collection<ControlEvent>('conversationEvents').findOne({ _id: sent.eventId });
  const consumer = new EventConsumer(sync, broker, 'notification');
  const reference = eventReference(event!);
  expect(await consumer.apply(reference)).toBe(true); expect(await consumer.apply(reference)).toBe(false); return sent;
}
async function expand(worker: NotificationWorker) { for (let n = 0; n < 20 && await worker.expandOnce(); n++) { /* bounded drain */ } }
it('applies additive 006 repeatedly without replacing previous validators or accounts', async () => {
  const a = await f.user('migrate'); await runMigrations(f.db);
  expect(await f.db.collection('schemaMigrations').countDocuments()).toBe(8);
  expect((await f.auth.current(a.token)).user.id).toBe(a.id);
  await expect(f.db.collection('pushSubscriptions').insertOne({ endpoint: 'unvalidated' })).rejects.toMatchObject({ code: 121 });
});
it('binds encrypted subscriptions to verified sessions, bounds admission and rejects SSRF/cross-account claims', async () => {
  const { a, b } = await pair('consent'), input = subscription();
  expect(await safety.settings(a.token)).toMatchObject({ enabled: false, subscribed: false });
  await expect(safety.subscribe(a.token, { ...input, endpoint: 'https://127.0.0.1/private' })).rejects.toMatchObject({ status: 400 });
  await expect(safety.subscribe(a.token, { ...input, endpoint: 'https://fcm.googleapis.com.evil.test/' })).rejects.toMatchObject({ status: 400 });
  expect(await safety.subscribe(a.token, input)).toMatchObject({ enabled: true, subscribed: true });
  const stored = await f.db.collection<DeviceRecord>('pushSubscriptions').findOne({ userId: a.id });
  expect(JSON.stringify(stored)).not.toContain(input.endpoint); expect(JSON.stringify(stored)).not.toContain(input.keys.auth);
  await expect(safety.subscribe(b.token, input)).rejects.toMatchObject({ status: 409 });
  const unverified = await f.user('unverified', false); await expect(safety.subscribe(unverified.token, subscription())).rejects.toMatchObject({ status: 403 });
  await safety.unsubscribe(a.token); expect(await safety.settings(a.token)).toMatchObject({ subscribed: false });
});
it('expands duplicate intents atomically and sends only a generic notice after provider acceptance', async () => {
  const { a, b, id } = await pair('push'), input = subscription(); await safety.subscribe(b.token, input);
  const sent = await intent(id, a.token), deliveries: DeviceSubscription[] = [];
  const worker = new NotificationWorker(safety, { async send(value) { deliveries.push(value); } });
  await expand(worker); expect(await worker.expandOnce()).toBe(false);
  expect(await f.db.collection<PushJob>('pushJobs').countDocuments({ eventId: sent.eventId })).toBe(1);
  expect(await worker.runOnce()).toBe(true); expect(await worker.runOnce()).toBe(false);
  expect(deliveries).toEqual([input]); expect(GENERIC_PUSH_PAYLOAD).toBe('{"v":1,"kind":"inbox"}');
  expect(await f.db.collection<PushJob>('pushJobs').findOne({ eventId: sent.eventId })).toMatchObject({ state: 'sent', outcome: 'PROVIDER_ACCEPTED' });
});
it('allows a fresh session to renew its own expired device without transferring another active session', async () => {
  const { a } = await pair('renew'), input = subscription(); await safety.subscribe(a.token, input);
  const fresh = await f.auth.login({ email: a.email, password: 'Synthetic-messaging-password-123', deviceLabel: 'Renewed browser' });
  await expect(safety.subscribe(fresh.token, input)).rejects.toMatchObject({ status: 409 });
  const current = await f.auth.current(a.token);
  await f.db.collection('sessions').updateOne({ tokenHash: { $exists: true }, userId: a.id, deviceLabel: { $ne: 'Renewed browser' } }, { $set: { expiresAt: new Date(0) } });
  expect(await safety.subscribe(fresh.token, input)).toMatchObject({ subscribed: true });
  expect(await f.db.collection<DeviceRecord>('pushSubscriptions').countDocuments({ userId: a.id })).toBe(1);
  expect((await f.db.collection<DeviceRecord>('pushSubscriptions').findOne({ userId: a.id }))!.sessionId).not.toBe(current.sessionId);
});
it('revalidates paused consent, revoked sessions, blocks and deleted messages before sending', async () => {
  for (const mode of ['pause', 'revoke', 'block', 'delete'] as const) {
    const { a, b, id } = await pair(mode); await safety.subscribe(b.token, subscription()); await intent(id, a.token);
    let calls = 0; const worker = new NotificationWorker(safety, { async send() { calls++; } }); await expand(worker);
    if (mode === 'pause') await safety.preference(b.token, false);
    if (mode === 'revoke') await f.auth.revoke(b.token, 'all');
    if (mode === 'block') await sync.setBlock(b.token, a.id, true);
    if (mode === 'delete') { const message = (await sync.snapshot(a.token, id)).messages[0]!; await sync.mutate(a.token, { kind: 'delete', commandId: randomUUID(), conversationId: id, messageId: message.id, expectedVersion: message.version }); }
    await worker.runOnce(); expect(calls).toBe(0);
  }
});
it('retries ambiguous provider outcomes, recovers an expired claim and removes a 410 endpoint', async () => {
  const { a, b, id } = await pair('retry'); await safety.subscribe(b.token, subscription()); const sent = await intent(id, a.token);
  let calls = 0; const worker = new NotificationWorker(safety, { async send() { calls++; if (calls === 1) throw new Error('Acceptance may have happened before timeout'); throw { statusCode: 410 }; } });
  await expand(worker); await worker.runOnce();
  expect(await f.db.collection<PushJob>('pushJobs').findOne({ eventId: sent.eventId })).toMatchObject({ state: 'pending', attempts: 1 });
  await f.db.collection<PushJob>('pushJobs').updateOne({ eventId: sent.eventId }, { $set: { state: 'claimed', leaseOwner: 'crashed-worker', leaseUntil: new Date(0) } });
  await new NotificationWorker(safety, worker.provider).runOnce();
  expect(calls).toBe(2); expect(await f.db.collection<DeviceRecord>('pushSubscriptions').countDocuments({ userId: b.id })).toBe(0);
  expect(await f.db.collection<PushJob>('pushJobs').findOne({ eventId: sent.eventId })).toMatchObject({ state: 'skipped', outcome: 'SUBSCRIPTION_GONE' });
});
it('keeps exhausted and expired notifications inspectable without sending', async () => {
  const { a, b, id } = await pair('expire'); await safety.subscribe(b.token, subscription()); const sent = await intent(id, a.token);
  let calls = 0; const worker = new NotificationWorker(safety, { async send() { calls++; } }); await expand(worker);
  await f.db.collection<PushJob>('pushJobs').updateOne({ eventId: sent.eventId }, { $set: { state: 'claimed', attempts: 5, leaseUntil: new Date(0) } });
  await worker.runOnce(); expect(calls).toBe(0); expect(await f.db.collection<PushJob>('pushJobs').findOne({ eventId: sent.eventId })).toMatchObject({ state: 'failed' });
  await f.db.collection<PushJob>('pushJobs').updateOne({ eventId: sent.eventId }, { $set: { state: 'pending', attempts: 0, expiresAt: new Date(0), availableAt: new Date(0) } });
  await worker.runOnce(); expect(calls).toBe(0); expect(await f.db.collection<PushJob>('pushJobs').findOne({ eventId: sent.eventId })).toMatchObject({ state: 'skipped', outcome: 'EXPIRED_OR_NO_AUTHORITY' });
});
it('keeps prejoin group references private and suppresses delivery after membership removal', async () => {
  const { a, b } = await pair('pushgroup'), group = (await sync.createGroup(a.token, randomUUID(), 'Push visibility')).conversationId;
  await safety.subscribe(b.token, subscription()); const early = await intent(group, a.token);
  await sync.invite(a.token, group, b.id); await sync.respondInvitation(b.token, group, true);
  let calls = 0; const worker = new NotificationWorker(safety, { async send() { calls++; } }); await expand(worker);
  expect(await f.db.collection<PushJob>('pushJobs').countDocuments({ eventId: early.eventId })).toBe(0);
  await expect(safety.report(b.token, { commandId: randomUUID(), conversationId: group, messageId: early.message.messageId, reason: 'spam' })).rejects.toMatchObject({ status: 403 });
  const late = await intent(group, a.token); await expand(worker);
  expect(await f.db.collection<PushJob>('pushJobs').countDocuments({ eventId: late.eventId })).toBe(1);
  await sync.remove(a.token, group, b.id); await worker.runOnce(); expect(calls).toBe(0);
});
it('rolls back expansion at its admission limit and later resumes without duplicate device jobs', async () => {
  const { a, b, id } = await pair('pushquota'); await safety.subscribe(b.token, subscription());
  const other = await f.auth.login({ email: b.email, password: 'Synthetic-messaging-password-123', deviceLabel: 'Second push device' }); await safety.subscribe(other.token, subscription());
  const sent = await intent(id, a.token), limited = new SafetyService(new AuthService({ ...f.config, MAX_PENDING_PUSH_JOBS: 1 }, f.client, f.db));
  const worker = new NotificationWorker(limited, { async send() { /* no real public provider */ } });
  await expect(worker.expandOnce()).rejects.toThrow('Push backlog full');
  expect(await f.db.collection<PushJob>('pushJobs').countDocuments({ eventId: sent.eventId })).toBe(0);
  expect(await f.db.collection('notificationJobs').findOne({ eventId: sent.eventId })).toMatchObject({ state: 'pending' });
  await safety.unsubscribe(other.token); await worker.expandOnce();
  expect(await f.db.collection<PushJob>('pushJobs').countDocuments({ eventId: sent.eventId })).toBe(1);
});
it('accepts authorized idempotent bounded reports, denies forged references and removed members', async () => {
  const { a, b, id } = await pair('report'), sent = await sync.send(a.token, command(id)), stranger = await f.user('stranger');
  const body = { commandId: randomUUID(), conversationId: id, messageId: sent.message.messageId, reason: 'spam' };
  const report = await safety.report(b.token, body); expect(await safety.report(b.token, body)).toEqual(report);
  await expect(safety.report(b.token, { ...body, reason: 'unsafe' })).rejects.toMatchObject({ status: 409 });
  await expect(safety.report(stranger.token, body)).rejects.toMatchObject({ status: 403 });
  await expect(safety.report(b.token, { ...body, commandId: randomUUID(), messageId: randomUUID() })).rejects.toMatchObject({ status: 403 });
  await safety.report(b.token, { ...body, commandId: randomUUID(), reason: 'harassment' });
  await expect(safety.report(b.token, { ...body, commandId: randomUUID() })).rejects.toMatchObject({ status: 429 });
  const group = (await sync.createGroup(a.token, randomUUID(), 'Report visibility')).conversationId;
  await sync.invite(a.token, group, b.id); await sync.respondInvitation(b.token, group, true); await sync.remove(a.token, group, b.id);
  await expect(safety.report(b.token, { ...body, conversationId: group, messageId: null })).rejects.toMatchObject({ status: 403 });
});
it('requires verified moderator authority and audits reference-only review and idempotent removal', async () => {
  const { a, b, id } = await pair('moderate'), sent = await sync.send(a.token, command(id, 'Sensitive body'));
  const report = await safety.report(b.token, { commandId: randomUUID(), conversationId: id, messageId: sent.message.messageId, reason: 'unsafe' });
  await expect(safety.reports(a.token)).rejects.toMatchObject({ status: 403 }); await expect(safety.decide(a.token, report.id, 'remove')).rejects.toMatchObject({ status: 403 });
  const moderator = await f.user('moderator'); await f.db.collection<UserRecord>('users').updateOne({ _id: moderator.id }, { $set: { role: 'moderator' } });
  expect(JSON.stringify(await safety.reports(moderator.token))).not.toContain('Sensitive body');
  const ticket = await sync.createSnapshot(b.token, 'conversation', id);
  await safety.decide(moderator.token, report.id, 'remove'); await safety.decide(moderator.token, report.id, 'remove');
  expect((await sync.snapshot(b.token, id)).messages[0]).toMatchObject({ deleted: true, text: '' });
  await expect(sync.snapshotPage(b.token, ticket.id, 0)).rejects.toMatchObject({ status: 403 });
  expect(await f.db.collection('auditEvents').countDocuments({ actorId: moderator.id, action: 'moderation.report.remove' })).toBe(1);
  const unverified = await f.user('modunverified', false); await f.db.collection<UserRecord>('users').updateOne({ _id: unverified.id }, { $set: { role: 'moderator' } });
  await expect(safety.reports(unverified.token)).rejects.toMatchObject({ status: 403 });
});
it('enforces CSRF, strict input and vertical authorization at the HTTP boundary', async () => {
  const { a } = await pair('http'), api = await createApi(f.config), origin = f.config.WEB_ORIGIN;
  try {
    const headers = { origin, cookie: `commonroom_session=${a.token}`, 'content-type': 'application/json' };
    // Use the actual configured cookie name, without guessing its transport security prefix.
    const login = await api.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin, 'content-type': 'application/json' }, payload: { email: a.email, password: 'Synthetic-messaging-password-123' } });
    const cookie = login.headers['set-cookie']!.toString().split(';')[0]!, csrf = (login.json() as { csrfToken: string }).csrfToken;
    expect((await api.app.inject({ method: 'PATCH', url: '/api/v1/safety/notifications', headers: { ...headers, cookie }, payload: { enabled: true } })).statusCode).toBe(403);
    expect((await api.app.inject({ method: 'PATCH', url: '/api/v1/safety/notifications', headers: { ...headers, cookie, 'x-csrf-token': csrf }, payload: { enabled: true, role: 'moderator' } })).statusCode).toBe(400);
    expect((await api.app.inject({ method: 'GET', url: '/api/v1/safety/moderation/reports', headers: { cookie } })).statusCode).toBe(403);
  } finally { await api.close(); }
});
it('revokes every session immediately, releases identity and resumes deletion while preserving other group authors', async () => {
  const { a, b, id } = await pair('deletion'), group = (await sync.createGroup(a.token, randomUUID(), 'Surviving group')).conversationId;
  await sync.invite(a.token, group, b.id); await sync.respondInvitation(b.token, group, true);
  await sync.send(a.token, command(id, 'Own direct body')); await sync.send(a.token, command(group, 'Own group body')); await sync.send(b.token, command(group, 'Keep peer body'));
  await safety.subscribe(a.token, subscription()); const extra = await f.auth.login({ email: a.email, password: 'Synthetic-messaging-password-123', deviceLabel: 'Other device' });
  await expect(safety.requestDeletion(a.token, { password: 'wrong', confirmation: 'DELETE' })).rejects.toMatchObject({ status: 400 });
  await safety.requestDeletion(a.token, { password: 'Synthetic-messaging-password-123', confirmation: 'DELETE' });
  await expect(f.auth.current(a.token)).rejects.toMatchObject({ status: 401 }); await expect(f.auth.current(extra.token)).rejects.toMatchObject({ status: 401 });
  await expect(sync.send(b.token, command(id))).rejects.toMatchObject({ status: 403 });
  expect(await f.db.collection<UserRecord>('users').findOne({ _id: a.id })).toMatchObject({ displayName: 'Deleted account', passwordHash: '', deletionState: 'deleting' });
  const maintenance = new SafetyMaintenance(safety);
  await f.db.collection<DeletionJob>('accountDeletionJobs').updateOne({ _id: a.id }, { $set: { state: 'claimed', leaseOwner: 'crashed', leaseUntil: new Date(0) } });
  for (let n = 0; n < 20; n++) { await f.db.collection<DeletionJob>('accountDeletionJobs').updateOne({ _id: a.id }, { $set: { availableAt: new Date(0) } }); if (!await maintenance.deletionOnce()) break; }
  expect(await f.db.collection<DeletionJob>('accountDeletionJobs').findOne({ _id: a.id })).toMatchObject({ state: 'done' });
  expect((await sync.snapshot(b.token, group)).messages.filter(m => !m.deleted).map(m => m.text)).toEqual(['Keep peer body']);
  expect((await sync.detail(b.token, group)).role).toBe('owner');
  expect(await f.db.collection('authEmailJobs').countDocuments({ userId: a.id })).toBe(0);
  expect(await f.db.collection('pushSubscriptions').countDocuments({ userId: a.id })).toBe(0);
});
it('waits for real object cleanup and quota settlement after storage failure before completing deletion', async () => {
  const { a, b } = await pair('objects'), files = new AttachmentService(f.auth), worker = new AttachmentWorker(files), data = Buffer.from('Delete my real private file.\n');
  const id = (await sync.createGroup(a.token, randomUUID(), 'Delete group file')).conversationId;
  await sync.invite(a.token, id, b.id); await sync.respondInvitation(b.token, id, true);
  try {
    const ticket = await files.reserve(a.token, { commandId: randomUUID(), conversationId: id, name: 'private.txt', kind: 'text', size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
    expect((await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: data })).status).toBe(200);
    await files.finalize(a.token, ticket.attachment.id, randomUUID()); await worker.runOnce();
    expect((await files.files().findOne({ _id: ticket.attachment.id }))!.state).toBe('ready');
    await sync.send(a.token, { ...command(id, ''), attachmentIds: [ticket.attachment.id] });
    const grant = await files.download(b.token, ticket.attachment.id);
    await safety.requestDeletion(a.token, { password: 'Synthetic-messaging-password-123', confirmation: 'DELETE' });
    await expect(files.download(b.token, ticket.attachment.id)).rejects.toMatchObject({ status: 403 });
    const maintenance = new SafetyMaintenance(safety); await maintenance.deletionOnce();
    await expect(files.download(b.token, ticket.attachment.id)).rejects.toMatchObject({ status: 403 });
    expect((await fetch(grant.url)).status).toBe(200); // Issued bearer URL remains valid within its documented window.
    await files.files().updateOne({ _id: ticket.attachment.id }, { $set: { uploadExpiresAt: new Date(0) } });
    const brokenAuth = new AuthService({ ...f.config, S3_ENDPOINT: 'http://127.0.0.1:1' }, f.client, f.db), broken = new AttachmentService(brokenAuth);
    try { await expect(new AttachmentWorker(broken).maintenanceOnce()).rejects.toThrow(); } finally { broken.close(); }
    expect((await f.db.collection<AttachmentQuota>('attachmentQuotas').findOne({ _id: a.id }))!.bytes).toBeGreaterThan(0);
    await worker.maintenanceOnce(); expect((await f.db.collection<AttachmentQuota>('attachmentQuotas').findOne({ _id: a.id }))!.bytes).toBe(0);
    for (let n = 0; n < 12; n++) { await f.db.collection<DeletionJob>('accountDeletionJobs').updateOne({ _id: a.id }, { $set: { availableAt: new Date(0) } }); await maintenance.deletionOnce(); }
    expect(await f.db.collection<DeletionJob>('accountDeletionJobs').findOne({ _id: a.id })).toMatchObject({ state: 'done' });
    expect((await fetch(grant.url)).status).not.toBe(200);
  } finally { files.close(); }
});
it('honors unlimited content by default and emits durable deletion events for configured retention', async () => {
  const { a, b, id } = await pair('retention'), sent = await sync.send(a.token, command(id, 'Aged content'));
  await f.db.collection<MessageRecord>('messages').updateOne({ _id: sent.message.messageId }, { $set: { createdAt: new Date(Date.now() - 2 * 86400000) } });
  expect(await new SafetyMaintenance(safety).retentionOnce()).toBe(false);
  const auth = new AuthService({ ...f.config, CONTENT_RETENTION_DAYS: 1 }, f.client, f.db);
  expect(await new SafetyMaintenance(new SafetyService(auth)).retentionOnce()).toBe(true);
  expect((await sync.snapshot(b.token, id)).messages[0]).toMatchObject({ deleted: true, text: '' });
  expect(await f.db.collection('outbox').countDocuments({ status: 'pending' })).toBeGreaterThan(0);
});
it('expires replay cursors through a consistent snapshot while preserving unpublished work across retention', async () => {
  const { a, b, id } = await pair('eventage'), sent = await sync.send(a.token, command(id, 'Snapshot survives event expiry'));
  const aged = new Date(Date.now() - 200 * 86400000);
  await f.db.collection<ControlEvent>('conversationEvents').updateMany({ conversationId: id }, { $set: { createdAt: aged } });
  const rows = await f.db.collection<ControlEvent>('conversationEvents').find({ conversationId: id }).toArray();
  await f.db.collection<OutboxRecord>('outbox').updateMany({ eventId: { $in: rows.filter(row => row._id !== sent.eventId).map(row => row._id) } }, { $set: { status: 'published', publishedAt: aged } });
  const maintenance = new SafetyMaintenance(safety);
  for (let n = 0; n < 100; n++) await maintenance.eventRetentionOnce();
  await expect(sync.replay(b.token, id, '0')).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
  expect((await sync.snapshot(b.token, id)).messages[0]!.text).toBe('Snapshot survives event expiry');
  expect(await f.db.collection<ControlEvent>('conversationEvents').countDocuments({ conversationId: id })).toBe(1);
  expect(await f.db.collection<OutboxRecord>('outbox').findOne({ _id: sent.eventId })).toMatchObject({ status: 'pending' });
  const consumer = new EventConsumer(sync, broker, 'notification');
  await expect(consumer.apply(eventReference((await f.db.collection<ControlEvent>('conversationEvents').findOne({ _id: sent.eventId }))!))).rejects.toThrow('Invalid or expired event reference');
});
it('advances the inbox floor and forces authoritative discovery instead of silently skipping expired events', async () => {
  const { b } = await pair('inboxage');
  await f.db.collection<InboxEvent>('inboxEvents').updateMany({ userId: b.id }, { $set: { createdAt: new Date(Date.now() - 100 * 86400000) } });
  const maintenance = new SafetyMaintenance(safety);
  for (let n = 0; n < 100; n++) await maintenance.inboxRetentionOnce();
  await expect(sync.inboxFeed(b.token, '0', undefined, 50)).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
  const ticket = await sync.createSnapshot(b.token, 'inbox');
  expect((await sync.snapshotPage(b.token, ticket.id, 0)).data).toHaveLength(1);
});
it('archives an owner-only group and recovers an exhausted deletion through the actual operator CLI', async () => {
  const a = await f.user('emptygroup'), id = (await sync.createGroup(a.token, randomUUID(), 'Owner only')).conversationId;
  await safety.requestDeletion(a.token, { password: 'Synthetic-messaging-password-123', confirmation: 'DELETE' });
  await f.db.collection<DeletionJob>('accountDeletionJobs').updateOne({ _id: a.id }, { $set: { state: 'claimed', attempts: 5, leaseOwner: 'crashed', leaseUntil: new Date(0) } });
  await new SafetyMaintenance(safety).deletionOnce();
  expect(await f.db.collection<DeletionJob>('accountDeletionJobs').findOne({ _id: a.id })).toMatchObject({ state: 'failed' });
  const env = { ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: f.db.databaseName };
  const result = await execute(process.execPath, ['--import', 'tsx', 'scripts/safety-jobs.ts', 'retry-deletion', a.id], { env, windowsHide: true });
  expect(result.stdout).toContain('Deletion retry queued.');
  for (let n = 0; n < 10; n++) { await f.db.collection<DeletionJob>('accountDeletionJobs').updateOne({ _id: a.id }, { $set: { availableAt: new Date(0) } }); await new SafetyMaintenance(safety).deletionOnce(); }
  expect(await f.db.collection<DeletionJob>('accountDeletionJobs').findOne({ _id: a.id })).toMatchObject({ state: 'done' });
  expect(await sync.conversations().findOne({ _id: id })).toMatchObject({ state: 'archived' });
});
it('reclaims an account deletion after the actual worker process exits with a persisted claim', async () => {
  const { a, b, id } = await pair('processcrash'); await sync.send(a.token, command(id, 'Resume after worker exit'));
  await safety.requestDeletion(a.token, { password: 'Synthetic-messaging-password-123', confirmation: 'DELETE' });
  await expect(execute(process.execPath, ['--import', 'tsx', 'tests/fixtures/deletion-crash.ts'], { env: { ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: f.db.databaseName }, windowsHide: true })).rejects.toMatchObject({ code: 86 });
  expect(await f.db.collection<DeletionJob>('accountDeletionJobs').findOne({ _id: a.id })).toMatchObject({ state: 'claimed', attempts: 1 });
  await f.db.collection<DeletionJob>('accountDeletionJobs').updateOne({ _id: a.id }, { $set: { leaseUntil: new Date(0) } });
  for (let n = 0; n < 10; n++) { await f.db.collection<DeletionJob>('accountDeletionJobs').updateOne({ _id: a.id }, { $set: { availableAt: new Date(0) } }); await new SafetyMaintenance(safety).deletionOnce(); }
  expect(await f.db.collection<DeletionJob>('accountDeletionJobs').findOne({ _id: a.id })).toMatchObject({ state: 'done' });
  expect((await sync.snapshot(b.token, id)).messages[0]).toMatchObject({ deleted: true, text: '' });
});
