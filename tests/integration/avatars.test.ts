import { randomUUID, createHash } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { AvatarService, AttachmentService, AttachmentWorker, AuthService, SyncService, SafetyService, SafetyMaintenance, runMigrations } from '@chat/domain';
import type { AttachmentJob, AttachmentQuota } from '@chat/domain';
import { createApi } from '@chat/api';
import { messagingFixture, command } from './messaging-fixture.js';
import { supportedMarkers } from '../../scripts/recovery/runtime.js';
import { png } from '../fixtures/png.js';
let f: Awaited<ReturnType<typeof messagingFixture>>, avatars: AvatarService, files: AttachmentService, worker: AttachmentWorker, sync: SyncService;
const bytes = png(16, 16, 'PRIVATE_AVATAR_METADATA_09A');
const input = (data = bytes) => ({ commandId: randomUUID(), name: 'portrait.png', kind: 'png', size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
beforeAll(async () => { f = await messagingFixture('avatars_test'); avatars = new AvatarService(f.auth); files = new AttachmentService(f.auth); worker = new AttachmentWorker(files); sync = new SyncService(f.auth); await files.storage.configureCors(); });
afterAll(async () => {
  if (files) { for (const bucket of [f.config.S3_QUARANTINE_BUCKET, f.config.S3_APPROVED_BUCKET]) { let cursor: string | undefined; do { const page = await files.storage.list(bucket, cursor); for (const row of page.Contents ?? []) if (row.Key) await files.storage.remove(bucket, row.Key); cursor = page.NextContinuationToken; } while (cursor); } files.close(); avatars.close(); }
  await f?.close();
});
async function processAll() { for (let n = 0; n < 30 && await worker.runOnce(); n++) { /* bounded real processing */ } }
async function upload(token: string, data = bytes) {
  const ticket = await avatars.reserve(token, input(data));
  expect((await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: data })).status).toBe(200);
  const id = randomUUID(); expect(await avatars.finalize(token, ticket.attachment.id, id)).toEqual(await avatars.finalize(token, ticket.attachment.id, id));
  return ticket.attachment.id;
}
async function published(label: string) {
  const owner = await f.user(label), id = await upload(owner.token); await processAll();
  await avatars.publish(owner.token, { commandId: randomUUID(), avatarId: id, expectedAvatarId: null }); return { owner, id };
}
it('reserves exactly once with signed type/size and rejects unverified, injected and foreign-purpose actions', async () => {
  const owner = await f.user('avreserve'), other = await f.user('avother'), unverified = await f.user('avunverified', false), raw = input();
  await expect(avatars.reserve(unverified.token, raw)).rejects.toMatchObject({ status: 403 });
  for (const bad of [{ ...raw, kind: 'text' }, { ...raw, size: 5242881 }, { ...raw, ownerId: other.id }]) await expect(avatars.reserve(owner.token, bad)).rejects.toMatchObject({ status: 400 });
  const ticket = await avatars.reserve(owner.token, raw), repeat = await avatars.reserve(owner.token, raw); expect(repeat.attachment.id).toBe(ticket.attachment.id);
  await expect(avatars.reserve(owner.token, { ...raw, name: 'changed.png' })).rejects.toMatchObject({ status: 409 });
  expect((await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: Buffer.from('wrong') })).status).toBe(403);
  expect((await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: bytes })).status).toBe(200);
  await expect(avatars.finalize(other.token, ticket.attachment.id, randomUUID())).rejects.toMatchObject({ status: 403 });
  await expect(files.finalize(owner.token, ticket.attachment.id, randomUUID())).rejects.toMatchObject({ status: 403 });
  await avatars.finalize(owner.token, ticket.attachment.id, randomUUID()); await processAll();
  expect((await avatars.profile(owner.token)).avatarId).toBeNull();
  await expect(avatars.downloadAvatar(owner.token, owner.id, {})).rejects.toMatchObject({ status: 403 });
  const direct = (await sync.createDirect(owner.token, other.id)).conversationId;
  await expect(sync.send(owner.token, { ...command(direct, ''), attachmentIds: [ticket.attachment.id] })).rejects.toMatchObject({ status: 409 });
  await expect(files.download(owner.token, ticket.attachment.id)).rejects.toMatchObject({ status: 403 });
  for (const action of ['removeFile', 'retry'] as const) await expect(files[action](owner.token, ticket.attachment.id, randomUUID())).rejects.toMatchObject({ status: 403 });
  expect((await files.list(owner.token, direct)).items).toHaveLength(0);
});
it('publishes only approved normalized images and bounds private/no-store bearer grants', async () => {
  const { owner, id } = await published('avgrant');
  const grant = await avatars.downloadAvatar(owner.token, owner.id, {}), response = await fetch(grant.url), normalized = Buffer.from(await response.arrayBuffer());
  expect(normalized.toString('ascii', 8, 12)).toBe('WEBP'); expect(response.headers.get('content-type')).toBe('image/webp');
  expect(bytes.includes(Buffer.from('PRIVATE_AVATAR_METADATA_09A'))).toBe(true); expect(normalized.includes(Buffer.from('PRIVATE_AVATAR_METADATA_09A'))).toBe(false);
  expect(response.headers.get('cache-control')).toContain('no-store'); expect(response.headers.get('content-disposition')).toBe('inline');
  expect(Number(new URL(grant.url).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(30); expect((await fetch(grant.url.split('?')[0]!)).status).toBe(403);
  const row = (await files.files().findOne({ _id: id }))!;
  // A still-valid quarantine upload cannot change immutable approved bytes.
  const ticket = await files.storage.upload(row); await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: Buffer.alloc(row.size) });
  expect(Buffer.from(await (await fetch((await avatars.downloadAvatar(owner.token, owner.id, {})).url)).arrayBuffer())).toEqual(normalized);
  expect((await f.auth.current(owner.token)).user.avatarId).toBe(id);
});
it('requires explicit sharing, active memberships and an unblocked pair even within a group', async () => {
  const { owner, id } = await published('avprivacy'), peer = await f.user('avpeer'), stranger = await f.user('avstranger');
  const group = (await sync.createGroup(owner.token, randomUUID(), 'Avatar privacy')).conversationId;
  expect((await sync.search(peer.token, owner.email.split('@')[0]!, undefined, 10)).users).toContainEqual(expect.objectContaining({ id: owner.id, avatarId: null }));
  await expect(avatars.downloadAvatar(undefined, owner.id, {})).rejects.toMatchObject({ status: 401 });
  await expect(avatars.publish(peer.token, { commandId: randomUUID(), avatarId: id, expectedAvatarId: null })).rejects.toMatchObject({ status: 403 });
  await expect(avatars.removeAvatar(peer.token, { commandId: randomUUID(), avatarId: id })).rejects.toMatchObject({ status: 403 });
  await sync.invite(owner.token, group, peer.id);
  const privacy = { commandId: randomUUID(), visibility: 'conversations' };
  await expect(avatars.downloadAvatar(peer.token, owner.id, { conversationId: group })).rejects.toMatchObject({ status: 403 });
  expect(await avatars.visibility(owner.token, privacy)).toEqual(await avatars.visibility(owner.token, privacy));
  await expect(avatars.downloadAvatar(peer.token, owner.id, { conversationId: group })).rejects.toMatchObject({ status: 403 });
  await sync.respondInvitation(peer.token, group, true);
  const oldGrant = await avatars.downloadAvatar(peer.token, owner.id, { conversationId: group });
  await expect(avatars.downloadAvatar(stranger.token, owner.id, { conversationId: group })).rejects.toMatchObject({ status: 403 });
  await expect(avatars.downloadAvatar(peer.token, owner.id, {})).rejects.toMatchObject({ status: 403 });
  await sync.setBlock(peer.token, owner.id, true); await expect(avatars.downloadAvatar(peer.token, owner.id, { conversationId: group })).rejects.toMatchObject({ status: 403 });
  await sync.setBlock(peer.token, owner.id, false); await avatars.downloadAvatar(peer.token, owner.id, { conversationId: group });
  await avatars.visibility(owner.token, { commandId: randomUUID(), visibility: 'self' });
  await expect(avatars.downloadAvatar(peer.token, owner.id, { conversationId: group })).rejects.toMatchObject({ status: 403 });
  expect((await fetch(oldGrant.url)).status).toBe(200); // Bounded previous bearer, not instant revocation.
  await avatars.visibility(owner.token, { commandId: randomUUID(), visibility: 'conversations' });
  await sync.remove(owner.token, group, peer.id); await expect(avatars.downloadAvatar(peer.token, owner.id, { conversationId: group })).rejects.toMatchObject({ status: 403 });
  expect((await files.files().findOne({ _id: id }))?.state).toBe('ready');
});
it('serializes concurrent publication and does not let stale publish/remove retries overwrite a newer avatar', async () => {
  const owner = await f.user('avrace'), first = await upload(owner.token), second = await upload(owner.token); await processAll();
  const a = { commandId: randomUUID(), avatarId: first, expectedAvatarId: null }, b = { commandId: randomUUID(), avatarId: second, expectedAvatarId: null };
  const results = await Promise.allSettled([avatars.publish(owner.token, a), avatars.publish(owner.token, b)]);
  expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1); expect(results.filter(row => row.status === 'rejected')).toHaveLength(1);
  const current = (await avatars.profile(owner.token)).avatarId!, next = current === first ? second : first;
  const winning = current === first ? a : b;
  await avatars.publish(owner.token, { commandId: randomUUID(), avatarId: next, expectedAvatarId: current });
  await avatars.publish(owner.token, winning); expect((await avatars.profile(owner.token)).avatarId).toBe(next);
  await avatars.removeAvatar(owner.token, { commandId: randomUUID(), avatarId: current }); expect((await avatars.profile(owner.token)).avatarId).toBe(next);
  expect(await files.files().countDocuments({ ownerId: owner.id, avatarActive: true, state: 'ready' })).toBe(1);
});
it('rejects spoofed or oversized decoded images and retries a real scanner outage without approving it', async () => {
  const owner = await f.user('avscan'), fake = await upload(owner.token, Buffer.from('This is not a PNG')), bomb = await upload(owner.token, png(9000, 1000)); await processAll();
  for (const id of [fake, bomb]) { expect((await files.files().findOne({ _id: id }))?.state).toBe('rejected'); await expect(avatars.publish(owner.token, { commandId: randomUUID(), avatarId: id, expectedAvatarId: null })).rejects.toMatchObject({ status: 403 }); }
  const id = await upload(owner.token), broken = new AttachmentService(new AuthService({ ...f.config, CLAMAV_PORT: 1 }, f.client, f.db));
  try { await new AttachmentWorker(broken).runOnce(); } finally { broken.close(); await broken.auth.close(); }
  expect((await files.files().findOne({ _id: id }))?.state).toBe('uploaded');
  await expect(avatars.publish(owner.token, { commandId: randomUUID(), avatarId: id, expectedAvatarId: null })).rejects.toMatchObject({ status: 403 });
  await f.db.collection<AttachmentJob>('attachmentJobs').updateOne({ _id: id }, { $set: { availableAt: new Date(0) } }); await processAll(); expect((await files.files().findOne({ _id: id }))?.state).toBe('ready');
  expect(await f.db.collection<AttachmentJob>('attachmentJobs').countDocuments({ _id: id })).toBe(1);
});
it('keeps active avatars past candidate expiry and settles removed object/quota state', async () => {
  const { owner, id } = await published('avexpiry'), unused = await upload(owner.token); await processAll();
  await files.files().updateMany({ ownerId: owner.id }, { $set: { expiresAt: new Date(0), uploadExpiresAt: new Date(0) } }); await worker.maintenanceOnce();
  expect((await files.files().findOne({ _id: unused }))?.state).toBe('deleted'); expect((await files.files().findOne({ _id: id }))?.state).toBe('ready');
  await avatars.downloadAvatar(owner.token, owner.id, {});
  const remove = { commandId: randomUUID(), avatarId: id }; expect(await avatars.removeAvatar(owner.token, remove)).toEqual(await avatars.removeAvatar(owner.token, remove));
  await expect(avatars.downloadAvatar(owner.token, owner.id, {})).rejects.toMatchObject({ status: 403 }); await worker.maintenanceOnce();
  expect((await f.db.collection<AttachmentQuota>('attachmentQuotas').findOne({ _id: owner.id }))?.bytes).toBe(0);
});
it('revokes avatar access immediately on account deletion and physically removes owned files through maintenance', async () => {
  const { owner, id } = await published('avdelete'), peer = await f.user('avdelpeer'), direct = (await sync.createDirect(owner.token, peer.id)).conversationId;
  await avatars.visibility(owner.token, { commandId: randomUUID(), visibility: 'conversations' }); await avatars.downloadAvatar(peer.token, owner.id, { conversationId: direct });
  const safety = new SafetyService(f.auth), maintenance = new SafetyMaintenance(safety); await safety.requestDeletion(owner.token, { password: 'Synthetic-messaging-password-123', confirmation: 'DELETE' });
  await expect(avatars.downloadAvatar(peer.token, owner.id, { conversationId: direct })).rejects.toMatchObject({ status: 403 });
  expect(await f.db.collection<{ _id: string }>('avatarSettings').countDocuments({ _id: owner.id })).toBe(0);
  await files.files().updateOne({ _id: id }, { $set: { uploadExpiresAt: new Date(0) } });
  for (let n = 0; n < 10; n++) { await f.db.collection<{ _id: string }>('accountDeletionJobs').updateOne({ _id: owner.id }, { $set: { availableAt: new Date(0) } }); await maintenance.deletionOnce(); await worker.maintenanceOnce(); }
  expect((await files.files().findOne({ _id: id }))?.state).toBe('deleted');
});
it('fails closed for missing approved bytes, quota exhaustion and expired candidates', async () => {
  const { owner, id } = await published('avmissing'), row = (await files.files().findOne({ _id: id }))!;
  await files.storage.remove(f.config.S3_APPROVED_BUCKET, row.approvedKey!); await expect(avatars.downloadAvatar(owner.token, owner.id, {})).rejects.toMatchObject({ status: 503 });
  const candidate = await upload(owner.token); await processAll(); await files.files().updateOne({ _id: candidate }, { $set: { expiresAt: new Date(0) } });
  await expect(avatars.publish(owner.token, { commandId: randomUUID(), avatarId: candidate, expectedAvatarId: id })).rejects.toMatchObject({ status: 403 });
  const limited = new AvatarService(new AuthService({ ...f.config, MAX_ACCOUNT_ATTACHMENT_BYTES: 1 }, f.client, f.db));
  try { await expect(limited.reserve(owner.token, input())).rejects.toMatchObject({ status: 409 }); } finally { limited.close(); await limited.auth.close(); }
  const bounded = await f.user('avlimit'); for (let n = 0; n < 9; n++) await avatars.reserve(bounded.token, input());
  const admissions = await Promise.allSettled([avatars.reserve(bounded.token, input()), avatars.reserve(bounded.token, input())]);
  expect(admissions.filter(row => row.status === 'fulfilled')).toHaveLength(1);
  expect(admissions.filter(row => row.status === 'rejected')).toHaveLength(1);
  expect(await files.files().countDocuments({ ownerId: bounded.id, purpose: 'avatar', state: { $ne: 'deleted' } })).toBe(10);
});
it('enforces actual HTTP origin/CSRF/strict schemas without allowing an avatar ID on attachment routes', async () => {
  const owner = await f.user('avhttp'), app = await createApi(f.config), headers = { origin: f.config.WEB_ORIGIN, cookie: `commonroom_session=${owner.token}`, 'content-type': 'application/json', 'x-csrf-token': owner.csrf };
  try {
    const request = (path: string, payload: unknown, extra = {}) => app.app.inject({ method: 'POST', url: '/api/v1' + path, headers: { ...headers, ...extra }, payload: JSON.stringify(payload) });
    expect((await request('/avatars', input(), { 'x-csrf-token': '' })).statusCode).toBe(403); expect((await request('/avatars', input(), { origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await request('/avatars', { ...input(), userId: randomUUID() })).statusCode).toBe(400);
    const result = await request('/avatars', input()); expect(result.statusCode).toBe(200); const id = (result.json() as { attachment: { id: string } }).attachment.id;
    expect((await request(`/attachments/${id}/finalize`, { commandId: randomUUID() })).statusCode).toBe(403);
    expect((await request('/avatars/privacy', { commandId: randomUUID(), visibility: 'public' })).statusCode).toBe(400);
  } finally { await app.close(); }
});
it('reruns additive 009 without changing previous markers and accepts only exact supported backup schemas', async () => {
  const markers = await f.db.collection('schemaMigrations').find().sort({ _id: 1 }).toArray(); expect(markers).toHaveLength(11); await runMigrations(f.db);
  expect(await f.db.collection('schemaMigrations').find().sort({ _id: 1 }).toArray()).toEqual(markers);
  expect(supportedMarkers(markers)).toBe(true); expect(supportedMarkers(markers.slice(0, 8))).toBe(true);
  expect(supportedMarkers([...markers, { _id: '010_unknown', appliedAt: new Date() }])).toBe(false);
  expect(supportedMarkers(markers.map((row, index) => index === 1 ? { ...row, _id: 'wrong' } : row))).toBe(false);
  const row = (await files.files().findOne({ purpose: 'avatar' }))!;
  await expect(files.files().insertOne({ ...row, _id: randomUUID(), sourceKey: `${f.config.MONGODB_DATABASE}/invalid/${randomUUID()}`, approvedKey: null, conversationId: randomUUID() })).rejects.toMatchObject({ code: 121 });
  const { purpose: _purpose, avatarActive: _active, ...withoutPurpose } = row;
  void _purpose; void _active;
  await expect(files.files().insertOne({ ...withoutPurpose, _id: randomUUID(), sourceKey: `${f.config.MONGODB_DATABASE}/invalid/${randomUUID()}`, approvedKey: null, conversationId: null })).rejects.toMatchObject({ code: 121 });
});
