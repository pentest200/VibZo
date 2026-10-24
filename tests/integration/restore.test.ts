import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Long } from 'mongodb';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createApi } from '@chat/api';
import { AuthService, AvatarService, avatarSchemaReady, AttachmentService, AttachmentStorage, AttachmentWorker, CallService, CallWorker, SyncService, SafetyService, BrokerTransport, OutboxRelay, EventConsumer, FanoutWorker, recoveryReady, runMigrations, unseal } from '@chat/domain';
import type { AttachmentRecord, EmailJobRecord, OutboxRecord, MessageRecord, ConversationRecord, MembershipRecord, VisibilityRecord } from '@chat/domain';
import { captureSnapshot, capturePolicy } from '../../scripts/recovery/capture.js';
import { restoreSnapshot } from '../../scripts/recovery/restore.js';
import { createBundle, inspectBundle, one } from '../../scripts/recovery/bundle.js';
import type { BundleManifest } from '../../scripts/recovery/bundle.js';
import { messagingFixture, command } from './messaging-fixture.js';
import { roleProcess, reservePort } from './telemetry-fixture.js';
import { png } from '../fixtures/png.js';
import { migrateAuth } from '../../packages/domain/src/auth/migrations.js';
import { migrateConversations } from '../../packages/domain/src/conversations/migrations.js';
import { migrateMessaging } from '../../packages/domain/src/messaging/migrations.js';
import { migrateSync } from '../../packages/domain/src/sync/migrations.js';
import { migrateAttachments } from '../../packages/domain/src/attachments/migrations.js';
import { migrateSafety } from '../../packages/domain/src/safety/migrations.js';
import { migrateCalls } from '../../packages/domain/src/calls/migrations.js';
import { migrateOperations } from '../../packages/domain/src/operations/migrations.js';

let f: Awaited<ReturnType<typeof messagingFixture>>, files: AttachmentService, sync: SyncService, calls: CallService;
type User = Awaited<ReturnType<typeof f.user>>;
let owner: User, peer: User, removed: User, outsider: User, deleting: User, group: string, callId: string;
let keepId: string, eraseId: string, keepCommand: Omit<ReturnType<typeof command>, 'attachmentIds'> & { attachmentIds: string[] }, eraseCommand: typeof keepCommand, accepted: Awaited<ReturnType<SyncService['send']>>, erased: typeof accepted;
let avatarId: string;
let original: BundleManifest, target: string, targetAuth: AuthService, targetSync: SyncService;
const key = randomBytes(32), directory = `.cache/recovery-drill-${randomUUID()}`, snapshot = directory + '/snapshot.crb', policy = directory + '/policy.crb', targets = new Set<string>(), metrics: Record<string, number> = {};
const snapshots = new Set<string>(), execute = promisify(execFile);
const newTarget = () => { const name = `restore_${randomUUID().replaceAll('-', '')}`; targets.add(name); return name; };
const bytes = Buffer.from('Approved private recovery bytes.\n'), newPassword = 'Fresh-recovery-password-123';
beforeAll(async () => {
  await mkdir(directory);
  f = await messagingFixture('recovery_test', { CALLS_ENABLED: 'true', LOG_LEVEL: 'error' }); files = new AttachmentService(f.auth); sync = new SyncService(f.auth); calls = new CallService(f.auth);
  owner = await f.user('restoreowner'); peer = await f.user('restorepeer'); removed = await f.user('removed'); outsider = await f.user('outsider'); deleting = await f.user('deleting');
  group = (await sync.createGroup(owner.token, randomUUID(), 'Recovery group')).conversationId;
  for (const user of [peer, removed, deleting]) { await sync.invite(owner.token, group, user.id); await sync.respondInvitation(user.token, group, true); }
  await f.db.collection<ConversationRecord>('conversations').updateOne({ _id: group }, { $set: { nextEventSeq: Long.fromString('9007199254740999') } });
  async function attachment(label: string) {
    const ticket = await files.reserve(owner.token, { commandId: randomUUID(), conversationId: group, name: label + '.txt', kind: 'text', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    expect((await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: bytes })).status).toBe(200); await files.finalize(owner.token, ticket.attachment.id, randomUUID());
    for (let n = 0; n < 10 && (await files.files().findOne({ _id: ticket.attachment.id }))?.state !== 'ready'; n++) await new AttachmentWorker(files).runOnce();
    expect((await files.files().findOne({ _id: ticket.attachment.id }))?.state).toBe('ready'); return ticket.attachment.id;
  }
  keepId = await attachment('kept'); eraseId = await attachment('removed');
  const avatars = new AvatarService(f.auth), image = png();
  try {
    const ticket = await avatars.reserve(owner.token, { commandId: randomUUID(), name: 'recovery-avatar.png', kind: 'png', size: image.length, sha256: createHash('sha256').update(image).digest('hex') });
    expect((await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: image })).status).toBe(200); avatarId = ticket.attachment.id;
    await avatars.finalize(owner.token, avatarId, randomUUID()); await new AttachmentWorker(files).runOnce();
    await avatars.publish(owner.token, { commandId: randomUUID(), avatarId, expectedAvatarId: null }); await avatars.visibility(owner.token, { commandId: randomUUID(), visibility: 'conversations' });
  } finally { avatars.close(); }
  keepCommand = { ...command(group, 'PRIVATE_BACKUP_MESSAGE_08C'), attachmentIds: [keepId] }; accepted = await sync.send(owner.token, keepCommand);
  eraseCommand = { ...command(group, 'PRIVATE_CURRENT_DELETION_08C'), attachmentIds: [eraseId] }; erased = await sync.send(owner.token, eraseCommand);
  await sync.send(deleting.token, command(group, 'PRIVATE_DELETED_ACCOUNT_08C'));
  // A real outstanding claim must become recoverable while retaining command/effect identity.
  await f.db.collection<OutboxRecord>('outbox').updateOne({ _id: accepted.eventId }, { $set: { status: 'claimed', leaseOwner: 'stopped-source-worker', leaseUntil: new Date(Date.now() + 30000) } });
  const call = await calls.start(owner.token, { commandId: randomUUID(), conversationId: group, mode: 'voice' }); callId = call.id; await new CallWorker(calls).runOnce();
  expect(await calls.provider.participants((await calls.calls().findOne({ _id: callId }))!.roomName)).not.toBeNull();
  const start = performance.now(); original = await captureSnapshot(f.config, snapshot, key); snapshots.add(original.id); metrics['backupMs'] = performance.now() - start;
  await sync.mutate(owner.token, { kind: 'delete', conversationId: group, messageId: erased.message.messageId, commandId: randomUUID(), expectedVersion: '0' });
  await sync.remove(owner.token, group, removed.id); await sync.changeRole(owner.token, group, peer.id, 'admin'); await sync.setBlock(owner.token, outsider.id, true);
  await new SafetyService(f.auth).requestDeletion(deleting.token, { password: 'Synthetic-messaging-password-123', confirmation: 'DELETE' });
  const policyStarted = performance.now(); await capturePolicy(f.config, snapshot, policy, key); metrics['policyMs'] = performance.now() - policyStarted;
});
afterAll(async () => {
  await targetAuth?.close();
  if (f) for (const name of targets) {
    if (!/^restore_[a-f0-9]{32}$/.test(name)) throw new Error('Unsafe fixture cleanup');
    const db = f.client.db(name); if (!await db.listCollections().hasNext()) continue;
    const control = await db.collection('restoreControl').findOne({ _id: 'state' as never });
    if (control ? !snapshots.has(String(control['snapshotId'])) : (await db.collection('sentinel').findOne())?.['fixture'] !== directory) throw new Error('Unexpected restore fixture');
    const users = await db.collection<{ _id: string }>('users').find().toArray(); if (users.some(user => ![owner, peer, removed, outsider, deleting].some(known => known.id === user._id))) throw new Error('Foreign user in restore fixture');
    const storage = new AttachmentStorage({ ...f.config, MONGODB_DATABASE: name });
    try { for (const bucket of [f.config.S3_APPROVED_BUCKET, f.config.S3_QUARANTINE_BUCKET]) { const page = await storage.list(bucket); for (const object of page.Contents ?? []) if (object.Key) await storage.remove(bucket, object.Key); } } finally { storage.close(); }
    const transport = await BrokerTransport.open({ ...f.config, MONGODB_DATABASE: name }); try { await transport.deleteTestTopology(); } finally { await transport.close(); }
    await db.dropDatabase();
  }
  if (calls) for (const room of await calls.rooms().find().toArray()) await calls.provider.removeRoom(room._id);
  if (files) { for (const bucket of [f.config.S3_APPROVED_BUCKET, f.config.S3_QUARANTINE_BUCKET]) { const page = await files.storage.list(bucket); for (const object of page.Contents ?? []) if (object.Key) await files.storage.remove(bucket, object.Key); } files.close(); }
  if (f) await f.close(); await writeFile(directory + '/timings.json', JSON.stringify(metrics));
});
async function reset(user: User) {
  await targetAuth.requestReset(user.email);
  const job = await targetAuth.db.collection<EmailJobRecord>('authEmailJobs').findOne({ userId: user.id, state: 'pending' }, { sort: { createdAt: -1 } });
  const payload = JSON.parse(unseal(job!.encryptedPayload!, f.config.AUTH_EMAIL_KEY)) as { text: string };
  const token = payload.text.match(/\/reset#token=([A-Za-z0-9_-]{43})/)![1]!;
  await targetAuth.consumeToken(token, 'reset', newPassword); return (await targetAuth.login({ email: user.email, password: newPassword, deviceLabel: 'Recovered device' })).token;
}

it('captures actual Mongo archives and approved bytes encrypted without writing plaintext artifacts', async () => {
  expect(original.entries.map(entry => entry.name)).toEqual(['database', 'object_0', 'object_1', 'object_2']); expect(original.entries[0]!.bytes).toBeGreaterThan(1000);
  for (const path of [snapshot, policy]) { const encrypted = await readFile(path); for (const secret of ['PRIVATE_BACKUP_MESSAGE_08C', owner.token, owner.email, bytes.toString()]) expect(encrypted.includes(Buffer.from(secret))).toBe(false); }
});
it('rejects a real transaction during capture and deletes only its incomplete encrypted output', async () => {
  const path = directory + '/changed.crb'; await expect(captureSnapshot(f.config, path, key, async () => { await sync.run(session => f.db.collection('users').updateOne({ _id: owner.id as never }, { $inc: { guardVersion: 1 } }, { session })); })).rejects.toThrow('Source changed');
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('authenticates everything before claiming a target and refuses source/development/existing namespaces', async () => {
  const wrong = newTarget(); await expect(restoreSnapshot(f.config, snapshot, policy, randomBytes(32), wrong)).rejects.toThrow('authentication'); expect(await f.client.db(wrong).listCollections().hasNext()).toBe(false);
  const tampered = directory + '/tampered.crb', raw = await readFile(snapshot); raw[35] = raw[35]! ^ 1; await writeFile(tampered, raw); const corrupt = newTarget(); await expect(restoreSnapshot(f.config, tampered, policy, key, corrupt)).rejects.toThrow('authentication'); expect(await f.client.db(corrupt).listCollections().hasNext()).toBe(false);
  for (const name of ['chat', f.config.MONGODB_DATABASE, 'admin']) await expect(restoreSnapshot(f.config, snapshot, policy, key, name)).rejects.toThrow('fresh');
  const occupied = newTarget(); await f.client.db(occupied).collection('sentinel').insertOne({ fixture: directory }); await expect(restoreSnapshot(f.config, snapshot, policy, key, occupied)).rejects.toThrow('already exists'); expect(await f.client.db(occupied).collection('sentinel').countDocuments()).toBe(1);
});
it('restores through the real tool while auth, readiness, old claims and migrations stay fenced until verified', async () => {
  target = newTarget(); const config = { ...f.config, MONGODB_DATABASE: target }; let loaded = false;
  const start = performance.now(); await restoreSnapshot(f.config, snapshot, policy, key, target, async stage => {
    const db = f.client.db(target); expect(await recoveryReady(db)).toBe(false);
    if (stage !== 'loaded') return; loaded = true; expect(await db.collection('users').countDocuments()).toBe(5); expect(await db.collection('schemaMigrations').countDocuments()).toBe(0);
    await expect(runMigrations(db)).rejects.toMatchObject({ status: 503 });
    const auth = new AuthService(config, f.client, db); await expect(auth.authenticate(owner.token)).rejects.toMatchObject({ status: 503 });
    expect(await new OutboxRelay(new SyncService(auth), {} as BrokerTransport).claim()).toBeNull();
    const api = await createApi(config); try { expect((await api.app.inject({ url: '/health/live' })).statusCode).toBe(200); expect((await api.app.inject({ url: '/health/ready' })).statusCode).toBe(503); expect((await api.app.inject({ url: '/health/dependencies' })).json()).toEqual({ mongodb: 'up' }); expect((await api.app.inject({ url: '/api/v1/auth/session', headers: { cookie: `commonroom_session=${owner.token}` } })).statusCode).toBe(503); } finally { await api.close(); await auth.close(); }
    const port = await reservePort(), process = await roleProcess('worker', { MONGODB_DATABASE: target, SMTP_PORT: '1' }, port);
    try { expect((await fetch(process.url + '/health/ready')).status).toBe(503); expect((await db.collection<OutboxRecord>('outbox').findOne({ _id: accepted.eventId }))?.leaseOwner).toBe('stopped-source-worker'); } finally { await process.close(); }
  }); metrics['restoreMs'] = performance.now() - start; expect(loaded).toBe(true);
  expect(await recoveryReady(f.client.db(target))).toBe(true); expect(await f.client.db(target).collection('schemaMigrations').countDocuments()).toBe(11);
  await runMigrations(f.client.db(target)); expect(await f.client.db(target).collection('schemaMigrations').countDocuments()).toBe(11);
  targetAuth = new AuthService(config, f.client, f.client.db(target)); await targetAuth.initialize(); targetSync = new SyncService(targetAuth);
  const indexes = await targetAuth.db.collection('messageCommands').listIndexes().toArray(); expect(indexes.some(index => index.unique && index.key['clientMessageId'] === 1)).toBe(true);
  await expect(targetAuth.db.collection('messages').insertOne({ invalid: true })).rejects.toMatchObject({ code: 121 });
  const row = await targetAuth.db.collection<MessageRecord>('messages').findOne({ _id: accepted.message.messageId }); expect(row!.creationSeq).toBeInstanceOf(Long); expect(row!.creationSeq.toString()).toBe(accepted.message.creationSequence);
});
it('invalidates old credentials and reapplies current deletion, membership and attachment authority before new sessions', async () => {
  expect(await targetAuth.db.collection('authEmailJobs').countDocuments({ state: { $in: ['pending', 'sending'] } })).toBe(0); expect(await targetAuth.db.collection('authTokens').countDocuments()).toBe(0); expect(await targetAuth.db.collection('sessions').countDocuments()).toBe(0);
  await expect(targetAuth.current(owner.token)).rejects.toMatchObject({ status: 401 }); await expect(targetAuth.login({ email: owner.email, password: 'Synthetic-messaging-password-123', deviceLabel: 'Old password' })).rejects.toMatchObject({ status: 401 });
  const ownerToken = await reset(owner), peerToken = await reset(peer), removedToken = await reset(removed), outsiderToken = await reset(outsider);
  const snapshot = await targetSync.snapshot(peerToken, group); expect(snapshot.messages.find(row => row.id === accepted.message.messageId)?.text).toBe(keepCommand.text);
  expect(snapshot.messages.find(row => row.id === erased.message.messageId)).toMatchObject({ text: '', deleted: true }); expect(JSON.stringify(snapshot)).not.toContain('PRIVATE_DELETED_ACCOUNT_08C');
  await expect(targetSync.snapshot(removedToken, group)).rejects.toMatchObject({ status: 403 }); await expect(targetSync.snapshot(outsiderToken, group)).rejects.toMatchObject({ status: 403 });
  await expect(targetSync.createDirect(outsiderToken, owner.id)).rejects.toMatchObject({ status: 403 }); expect((await targetSync.members().findOne({ conversationId: group, userId: peer.id }))?.role).toBe('admin');
  const sourceSequence = (await sync.conversations().findOne({ _id: group }))!.nextEventSeq, recoveredSequence = (await targetSync.conversations().findOne({ _id: group }))!.nextEventSeq; expect(recoveredSequence.greaterThan(sourceSequence)).toBe(true);
  expect((await targetAuth.db.collection('users').findOne({ _id: deleting.id as never }))?.['deletionState']).toBe('deleted');
  const restoredFiles = new AttachmentService(targetAuth); try { const grant = await restoredFiles.download(peerToken, keepId); expect(Buffer.from(await (await fetch(grant.url)).arrayBuffer())).toEqual(bytes); await expect(restoredFiles.download(outsiderToken, keepId)).rejects.toMatchObject({ status: 403 }); await expect(restoredFiles.download(peerToken, eraseId)).rejects.toMatchObject({ status: 403 }); } finally { restoredFiles.close(); }
  expect(await targetSync.send(ownerToken, keepCommand)).toEqual(accepted); expect(await targetSync.send(ownerToken, eraseCommand)).toEqual(erased); expect(await targetAuth.db.collection('messages').countDocuments({ clientMessageId: keepCommand.clientMessageId })).toBe(1);
  await expect(targetSync.replay(peerToken, group, '0')).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
  const recoveredCall = new CallService(targetAuth); expect((await recoveredCall.calls().findOne({ _id: callId }))?.state).toBe('ended'); await expect(recoveredCall.join(ownerToken, callId)).rejects.toMatchObject({ status: 403 }); expect(await recoveredCall.rooms().countDocuments()).toBe(0);
});
it('reconciles retained pending outbox identities and suppresses old notification deliveries', async () => {
  const transport = await BrokerTransport.open(targetAuth.config);
  try {
    const relay = new OutboxRelay(targetSync, transport); while (await relay.runOnce()) { /* bounded fixture */ }
    expect((await targetAuth.db.collection<OutboxRecord>('outbox').findOne({ _id: accepted.eventId }))?.status).toBe('published');
    const event = (await targetAuth.db.collection('conversationEvents').findOne({ _id: accepted.eventId as never }))!;
    const { eventReference } = await import('@chat/domain');
    expect(await new EventConsumer(targetSync, transport, 'notification').apply(eventReference(event as never))).toBe(false);
    await new EventConsumer(targetSync, transport, 'fanout').apply(eventReference(event as never));
    const fanout = new FanoutWorker(targetAuth.db, targetAuth.config); try { while (await fanout.runOnce()) { /* bounded */ } } finally { await fanout.close(); }
    expect(await targetAuth.db.collection('pushSubscriptions').countDocuments()).toBe(0); expect(await targetAuth.db.collection('pushJobs').countDocuments({ state: { $in: ['pending', 'claimed'] } })).toBe(0);
    expect(await targetAuth.db.collection('authEmailJobs').countDocuments({ state: 'sending' })).toBe(0);
  } finally { await transport.close(); }
});

async function rewrite(source: string, destination: string, change: (manifest: BundleManifest) => void, omit?: string) {
  const entries = new Map<string, Buffer[]>(); let active = '';
  const meta = await inspectBundle(source, key, { async begin(name) { active = name; entries.set(name, []); }, async data(bytes) { entries.get(active)!.push(bytes); }, async end() {} }); change(meta);
  const rewritten = await createBundle(destination, key, { kind: meta.kind, source: meta.source, capturedAt: meta.capturedAt, detail: meta.detail }, async add => { for (const [name, parts] of entries) if (name !== omit) await add(name, one(Buffer.concat(parts))); }); if (rewritten.kind === 'snapshot') snapshots.add(rewritten.id); return rewritten;
}
it('retires approved avatars and sharing through actual encrypted restore without changing source authority', async () => {
  expect((await files.files().findOne({ _id: avatarId }))?.avatarActive).toBe(true);
  expect((await targetAuth.db.collection<{ _id: string; avatarId: string | null }>('users').findOne({ _id: owner.id }))?.avatarId).toBeNull();
  expect(await targetAuth.db.collection<{ _id: string; visibility: string }>('avatarSettings').findOne({ _id: owner.id })).toMatchObject({ visibility: 'self' });
  expect(await targetAuth.db.collection<AttachmentRecord>('attachments').findOne({ _id: avatarId })).toMatchObject({ state: 'deleted', approvedKey: null, reservedBytes: 0 });
});
it('restores a real schema-008 archive and enables avatars only after additive 009 migration', async () => {
  const legacy = `recovery_test_${randomUUID().replaceAll('-', '')}`, db = f.client.db(legacy), config = { ...f.config, MONGODB_DATABASE: legacy };
  if (await db.listCollections().hasNext()) throw new Error('Occupied historical recovery fixture');
  try {
    // Materialize exact immutable 001-008 validators/indexes, not a forged 009 manifest.
    await migrateAuth(db); const assertOwned = async () => { if (db.databaseName !== legacy || !/^recovery_test_[a-f0-9]{32}$/.test(legacy)) throw new Error('Foreign historical fixture'); };
    for (const migrate of [migrateConversations, migrateMessaging, migrateSync, migrateAttachments, migrateSafety, migrateCalls, migrateOperations]) await migrate(db, assertOwned);
    const saved = directory + '/legacy008.crb', authority = directory + '/legacy008-policy.crb';
    const snapshot = await captureSnapshot(config, saved, key); snapshots.add(snapshot.id); await capturePolicy(config, saved, authority, key);
    const restored = newTarget(); await restoreSnapshot(config, saved, authority, key, restored); const target = f.client.db(restored);
    expect(await avatarSchemaReady(target)).toBe(false); const markers = await target.collection('schemaMigrations').find().sort({ _id: 1 }).toArray(); expect(markers).toHaveLength(8);
    await runMigrations(target); expect(await avatarSchemaReady(target)).toBe(true);
    expect((await target.collection('schemaMigrations').find().sort({ _id: 1 }).toArray()).slice(0, 8)).toEqual(markers);
  } finally { await db.dropDatabase(); }
});
it('rejects stale and foreign policy bundles without creating a target', async () => {
  for (const mode of ['stale', 'foreign']) { const file = `${directory}/${mode}.crb`; await rewrite(policy, file, manifest => { if (mode === 'stale') manifest.capturedAt = new Date(Date.now() - 7200000).toISOString(); else manifest.detail['snapshotId'] = 'f'.repeat(32); }); const name = newTarget(); await expect(restoreSnapshot(f.config, snapshot, file, key, name)).rejects.toThrow('matching current policy'); expect(await f.client.db(name).listCollections().hasNext()).toBe(false); }
});
it('keeps an authenticated but incomplete approved-object restore unavailable', async () => {
  const incomplete = directory + '/missing-object.crb', alternatePolicy = directory + '/missing-policy.crb';
  const object = (original.detail['objects'] as { id: string; entry: string }[]).find(item => item.id === keepId)!;
  const altered = await rewrite(snapshot, incomplete, manifest => { manifest.detail['objects'] = (manifest.detail['objects'] as { entry: string }[]).filter(row => row.entry !== object.entry); }, object.entry);
  await rewrite(policy, alternatePolicy, manifest => { manifest.detail['snapshotId'] = altered.id; });
  const name = newTarget(); await expect(restoreSnapshot(f.config, incomplete, alternatePolicy, key, name)).rejects.toThrow('Unverified object'); expect(await recoveryReady(f.client.db(name))).toBe(false); expect(await f.client.db(name).collection('schemaMigrations').countDocuments()).toBe(0);
});
it('refuses a source whose approved metadata points to missing physical bytes', async () => {
  const row = (await files.files().findOne({ _id: keepId }))!, id = randomUUID(), path = directory + '/missing-source.crb';
  await files.files().insertOne({ ...row, _id: id, sourceKey: `${f.config.MONGODB_DATABASE}/missing-source/${id}`, approvedKey: `${f.config.MONGODB_DATABASE}/missing/${id}`, messageId: null });
  try { await expect(captureSnapshot(f.config, path, key)).rejects.toThrow(); await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' }); }
  finally { await f.db.collection<AttachmentRecord>('attachments').deleteOne({ _id: id }); }
});
it('runs the actual CLI with runtime-only keys and a fresh target', async () => {
  const env = { ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: f.config.MONGODB_DATABASE, RECOVERY_KEY: key.toString('hex') };
  const run = async (args: string[]) => (await execute(process.execPath, ['--import', 'tsx', 'scripts/recovery.ts', ...args], { env, windowsHide: true, timeout: 90000, maxBuffer: 65536 })).stdout;
  const cliSnapshot = directory + '/cli-snapshot.crb', cliPolicy = directory + '/cli-policy.crb';
  const captured = JSON.parse(await run(['backup', cliSnapshot])) as { id: string }; snapshots.add(captured.id);
  await run(['policy', cliSnapshot, cliPolicy]); const name = newTarget(), start = performance.now(); const output = await run(['restore', cliSnapshot, cliPolicy, name]); metrics['cliRestoreMs'] = performance.now() - start;
  expect(output).not.toContain(env.RECOVERY_KEY); expect(JSON.parse(output)).toMatchObject({ target: name, snapshotId: captured.id }); expect(await recoveryReady(f.client.db(name))).toBe(true);
});

it('preserves personal message/chat privacy, unpinning and pending group deletion when restoring an earlier schema-011 snapshot', async () => {
  const direct = (await sync.createDirect(owner.token, peer.id)).conversationId;
  const directMessage = await sync.send(peer.token, command(direct, 'Clear this personal history'));
  const personal = (await sync.createGroup(owner.token, randomUUID(), 'Personal policy after backup')).conversationId;
  await sync.invite(owner.token, personal, peer.id); await sync.respondInvitation(peer.token, personal, true);
  const hiddenMessage = await sync.send(owner.token, command(personal, 'Hide only for peer'));
  await sync.mutate(owner.token, { kind: 'pin', commandId: randomUUID(), conversationId: personal, messageId: hiddenMessage.message.messageId, active: true });
  const doomed = (await sync.createGroup(owner.token, randomUUID(), 'Deleted after backup')).conversationId;
  await sync.invite(owner.token, doomed, peer.id); await sync.respondInvitation(peer.token, doomed, true);
  const ticket = await files.reserve(owner.token, { commandId: randomUUID(), conversationId: doomed, name: 'retire-after-backup.txt', kind: 'text', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  expect((await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: bytes })).status).toBe(200); await files.finalize(owner.token, ticket.attachment.id, randomUUID());
  for (let n = 0; n < 10 && (await files.files().findOne({ _id: ticket.attachment.id }))?.state !== 'ready'; n++) await new AttachmentWorker(files).runOnce();
  expect((await files.files().findOne({ _id: ticket.attachment.id }))?.state).toBe('ready');
  await sync.send(owner.token, { ...command(doomed, 'Do not restore a deleted group body'), attachmentIds: [ticket.attachment.id] });
  const saved = directory + '/chat010.crb', authority = directory + '/chat010-policy.crb';
  const captured = await captureSnapshot(f.config, saved, key); snapshots.add(captured.id);
  await sync.mutate(peer.token, { kind: 'hide', commandId: randomUUID(), conversationId: personal, messageId: hiddenMessage.message.messageId });
  await sync.mutate(owner.token, { kind: 'pin', commandId: randomUUID(), conversationId: personal, messageId: hiddenMessage.message.messageId, active: false });
  await sync.preference(peer.token, personal, randomUUID(), 'archive-chat', true); await sync.preference(peer.token, personal, randomUUID(), 'pin-chat', true);
  await sync.manage(owner.token, direct, randomUUID(), 'delete'); await sync.manage(owner.token, doomed, randomUUID(), 'delete-group');
  // Capture before cleanup drains: the durable request itself must protect old content.
  expect((await files.files().findOne({ _id: ticket.attachment.id }))?.state).toBe('ready');
  await capturePolicy(f.config, saved, authority, key);
  const restored = newTarget(); await restoreSnapshot(f.config, saved, authority, key, restored); const db = f.client.db(restored);
  expect(await db.collection<MembershipRecord>('memberships').findOne({ conversationId: direct, userId: owner.id })).toMatchObject({ state: 'active', hidden: true });
  expect(await db.collection<VisibilityRecord>('visibilityIntervals').findOne({ conversationId: direct, userId: owner.id, startSeq: { $lte: Long.fromString(directMessage.message.creationSequence) }, endSeq: null })).toBeNull();
  expect(await db.collection<ConversationRecord>('conversations').findOne({ _id: doomed })).toMatchObject({ state: 'archived', deletionRequestedAt: expect.any(Date) });
  expect(await db.collection<MessageRecord>('messages').findOne({ conversationId: doomed })).toMatchObject({ text: '', deletedAt: expect.any(Date) });
  expect(await db.collection<AttachmentRecord>('attachments').findOne({ _id: ticket.attachment.id })).toMatchObject({ state: 'deleted', approvedKey: null });
  expect(await recoveryReady(db)).toBe(true);
  expect(await db.collection<MessageRecord>('messages').findOne({ _id: hiddenMessage.message.messageId })).toMatchObject({ text: 'Hide only for peer', deletedAt: null, hiddenFor: [peer.id], pinned: false });
  expect(await db.collection<MembershipRecord>('memberships').findOne({ conversationId: personal, userId: peer.id })).toMatchObject({ pinned: true, archived: true });
  const legacy = directory + '/chat010-declared009.crb', legacyPolicy = directory + '/chat010-declared009-policy.crb';
  const altered = await rewrite(saved, legacy, manifest => { manifest.detail['markers'] = JSON.stringify((JSON.parse(String(manifest.detail['markers'])) as unknown[]).slice(0, 9)); });
  await rewrite(authority, legacyPolicy, manifest => { manifest.detail['snapshotId'] = altered.id; });
  const rejected = newTarget(); await expect(restoreSnapshot(f.config, legacy, legacyPolicy, key, rejected)).rejects.toThrow('schema-011 snapshot'); expect(await f.client.db(rejected).listCollections().hasNext()).toBe(false);
});
