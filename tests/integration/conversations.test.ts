import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { Long } from 'mongodb';
import { createApi } from '@chat/api';
import { loadConfig } from '@chat/config';
import { registerSchema, loginSchema, conversationSchema, historySchema, inboxSnapshotSchema, inboxFeedSchema } from '@chat/contracts';
import { AuthService, ConversationService, createMongoClient, runMigrations, unseal } from '@chat/domain';
import type { EmailJobRecord, UserRecord, ConversationRecord, MembershipRecord, MessageRecord, InboxCounter } from '@chat/domain';

const config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: `conversation_test_${randomUUID().replaceAll('-', '')}`, MAX_GROUP_MEMBERS: '3' });
const client = createMongoClient(config), db = client.db(config.MONGODB_DATABASE);
const auth = new AuthService(config, client, db), service = new ConversationService(auth);
const password = 'Synthetic-conversation-password-123';
type User = { id: string; token: string; csrf: string; username: string };
let server: Awaited<ReturnType<typeof createApi>>, base: string;
async function user(label: string, verify = true): Promise<User> {
  const username = `${label}_${randomUUID().slice(0, 8)}`;
  const input = registerSchema.parse({ username, email: `${username}@example.test`, displayName: label, password });
  await auth.register(input);
  const stored = await db.collection<UserRecord>('users').findOne({ usernameCanonical: username });
  if (verify) {
    const job = await db.collection<EmailJobRecord>('authEmailJobs').findOne({ userId: stored!._id });
    const payload = JSON.parse(unseal(job!.encryptedPayload!, config.AUTH_EMAIL_KEY)) as { text: string };
    await auth.consumeToken(payload.text.match(/\/verify#token=([A-Za-z0-9_-]{43})/)![1]!, 'verify');
  }
  const signed = await auth.login(loginSchema.parse({ email: input.email, password }));
  return { id: signed.session.user.id, token: signed.token, csrf: signed.session.csrfToken, username };
}
const group = async (u: User, title = 'Real group') => (await service.createGroup(u.token, randomUUID(), title)).conversationId;
async function join(owner: User, member: User, id: string) { await service.invite(owner.token, id, member.id); await service.respondInvitation(member.token, id, true); }
const forbidden = (operation: Promise<unknown>) => expect(operation).rejects.toMatchObject({ status: 403 });
async function request(u: User, path: string, method = 'GET', body?: unknown, csrf = u.csrf, origin = config.WEB_ORIGIN) {
  return fetch(`${base}/api/v1${path}`, { method, headers: { Origin: origin, Cookie: `commonroom_session=${u.token}`, 'X-CSRF-Token': csrf, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
beforeAll(async () => { await client.connect(); await runMigrations(db); await runMigrations(db); await auth.initialize(); server = await createApi(config); await server.app.listen(0, '127.0.0.1'); base = await server.app.getUrl(); });
afterAll(async () => { if (server) await server.close(); await auth.close(); await db.dropDatabase(); await client.close(); });

it('requires verified sessions, CSRF and strict caller-free inputs over real HTTP', async () => {
  const a = await user('http'), b = await user('other'), unverified = await user('unverified', false);
  expect((await request(unverified, '/inbox/snapshot')).status).toBe(403);
  expect((await request(a, '/conversations/direct', 'POST', { targetUserId: b.id }, '')).status).toBe(403);
  expect((await request(a, '/conversations/direct', 'POST', { targetUserId: b.id }, a.csrf, 'https://evil.example')).status).toBe(403);
  expect((await request(a, '/conversations/direct', 'POST', { targetUserId: b.id, senderId: a.id })).status).toBe(400);
  expect((await request(a, '/users?prefix=a')).status).toBe(400);
  expect((await request(a, '/inbox/events?after=01')).status).toBe(400);
  const response = await request(a, '/conversations/direct', 'POST', { targetUserId: b.id }); expect(response.status).toBe(200);
  const { conversationId } = await response.json() as { conversationId: string };
  expect(conversationSchema.parse(await (await request(a, `/conversations/${conversationId}`)).json()).kind).toBe('direct');
  expect(historySchema.parse(await (await request(b, `/conversations/${conversationId}/messages`)).json()).messages).toEqual([]);
});
it('concurrent reciprocal direct creation returns one canonical pair and atomic durable records', async () => {
  const a = await user('paira'), b = await user('pairb');
  const results = await Promise.all([service.createDirect(a.token, b.id), service.createDirect(b.token, a.id), service.createDirect(a.token, b.id)]);
  const id = results[0]!.conversationId; expect(new Set(results.map(result => result.conversationId)).size).toBe(1);
  expect(await db.collection('memberships').countDocuments({ conversationId: id })).toBe(2);
  expect(await db.collection('conversationEvents').countDocuments({ conversationId: id })).toBe(1);
  const event = await db.collection('conversationEvents').findOne({ conversationId: id });
  expect(await db.collection('outbox').countDocuments({ eventId: event!['_id'] })).toBe(1);
  expect(await db.collection('inboxEvents').countDocuments({ conversationId: id })).toBe(2);
  const stored = await db.collection<ConversationRecord>('conversations').findOne({ _id: id });
  await expect(db.collection<ConversationRecord>('conversations').insertOne({ ...stored!, _id: randomUUID() })).rejects.toMatchObject({ code: 11000 });
});
it('group creation retries replay the same result and reject changed content without extra effects', async () => {
  const a = await user('commands'), key = randomUUID();
  const results = await Promise.all([service.createGroup(a.token, key, 'One'), service.createGroup(a.token, key, 'One')]);
  expect(results[0]).toEqual(results[1]);
  await expect(service.createGroup(a.token, key, 'Different')).rejects.toMatchObject({ status: 409 });
  expect(await db.collection('conversationEvents').countDocuments({ conversationId: results[0]!.conversationId })).toBe(1);
});
it('denies outsiders and role escalation, requires ownership transfer before leave, and removes access', async () => {
  const a = await user('owner'), b = await user('member'), c = await user('stranger'), id = await group(a);
  await forbidden(service.detail(c.token, id)); await forbidden(service.history(c.token, id, undefined, undefined, 10)); await forbidden(service.invite(c.token, id, b.id));
  await join(a, b, id); await forbidden(service.changeRole(b.token, id, a.id, 'admin')); await forbidden(service.rename(b.token, id, 'Stolen'));
  await expect(service.remove(a.token, id, undefined)).rejects.toMatchObject({ status: 409 });
  await service.changeRole(a.token, id, b.id, 'admin'); await forbidden(service.remove(b.token, id, a.id));
  await service.rename(b.token, id, 'Admin renamed'); expect((await service.detail(a.token, id)).title).toBe('Admin renamed');
  await join(b, c, id); await service.changeRole(a.token, id, c.id, 'admin'); await forbidden(service.remove(b.token, id, c.id));
  await service.transferOwner(a.token, id, b.id); expect((await service.detail(b.token, id)).role).toBe('owner');
  await service.remove(a.token, id, undefined); await forbidden(service.detail(a.token, id));
  await service.remove(b.token, id, c.id);
  await service.remove(b.token, id, undefined); await forbidden(service.detail(b.token, id));
});
it('serializes group capacity including pending invitations, duplicate acceptance, decline and expiration', async () => {
  const a = await user('capacity'), b = await user('inviteb'), c = await user('invitec'), d = await user('invited'), id = await group(a);
  const results = await Promise.allSettled([service.invite(a.token, id, b.id), service.invite(a.token, id, c.id), service.invite(a.token, id, d.id)]);
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(2);
  const pending = await db.collection<MembershipRecord>('memberships').find({ conversationId: id, state: 'invited' }).toArray();
  const users = [b, c, d], accepted = users.find(u => u.id === pending[0]!.userId)!, declined = users.find(u => u.id === pending[1]!.userId)!;
  await forbidden(service.history(accepted.token, id, undefined, undefined, 10));
  await Promise.all([service.respondInvitation(accepted.token, id, true), service.respondInvitation(accepted.token, id, true)]);
  expect(await db.collection('visibilityIntervals').countDocuments({ conversationId: id, userId: accepted.id })).toBe(1);
  await service.respondInvitation(declined.token, id, false); await service.invite(a.token, id, declined.id);
  await db.collection<MembershipRecord>('memberships').updateOne({ conversationId: id, userId: declined.id }, { $set: { invitationExpiresAt: new Date(0) } });
  await forbidden(service.respondInvitation(declined.token, id, true));
  expect((await service.inbox(declined.token, undefined, 10)).items).not.toContainEqual(expect.objectContaining({ id }));
  expect(await service.expireInvitationsOnce()).toBe(1); expect(await service.expireInvitationsOnce()).toBe(0);
  expect(await db.collection('conversationEvents').countDocuments({ conversationId: id, kind: 'member.invitation_expired' })).toBe(1);
});
it('honors discoverability, bounded cursor search and bilateral direct blocking while retaining prior history', async () => {
  const a = await user('searcher'), b = await user('findme'), hidden = await user('findme');
  await db.collection<UserRecord>('users').updateOne({ _id: hidden.id }, { $set: { 'privacy.allowSearch': false } });
  const found = await service.search(a.token, 'findme', undefined, 1); expect(found.users.map(u => u.id)).toEqual([b.id]);
  expect(found.users[0]).not.toHaveProperty('email'); await forbidden(service.createDirect(a.token, hidden.id));
  const id = (await service.createDirect(a.token, b.id)).conversationId;
  await service.setBlock(a.token, b.id, true); await service.setBlock(a.token, b.id, true);
  expect((await service.search(b.token, a.username.slice(0, 4), undefined, 10)).users).toEqual([]);
  await forbidden(service.createDirect(b.token, a.id)); await forbidden(service.authorizedOperation(b.token, id, async () => true));
  expect((await service.detail(b.token, id)).blocked).toBe(true); expect((await service.history(b.token, id, undefined, undefined, 10)).messages).toEqual([]);
  expect((await service.listBlocks(a.token, undefined, 1)).users.map(u => u.id)).toEqual([b.id]); expect((await service.listBlocks(b.token, undefined, 10)).users).toEqual([]);
  await service.setBlock(b.token, a.id, true); await service.setBlock(a.token, b.id, false); await forbidden(service.createDirect(a.token, b.id));
  await service.setBlock(b.token, a.id, false); expect((await service.createDirect(a.token, b.id)).conversationId).toBe(id);
  await db.collection<UserRecord>('users').updateOne({ _id: b.id }, { $set: { 'privacy.allowSearch': false } });
  expect((await service.createDirect(a.token, b.id)).conversationId).toBe(id);
});
it('advances search cursors across a blocked page without leaking or duplicating identities', async () => {
  const a = await user('lookupactor'), b = await user('lookuptarget'), c = await user('lookuptarget');
  const sorted = [b, c].sort((one, two) => one.username.localeCompare(two.username)); await service.setBlock(a.token, sorted[0]!.id, true);
  const first = await service.search(a.token, 'lookuptarget', undefined, 1); expect(first.users).toEqual([]); expect(first.nextCursor).toBe(sorted[0]!.username);
  const second = await service.search(a.token, 'lookuptarget', first.nextCursor!, 1); expect(second.users.map(u => u.id)).toEqual([sorted[1]!.id]); expect(second.nextCursor).toBeNull();
  await expect(service.search(a.token, 'different', first.nextCursor!, 1)).rejects.toMatchObject({ status: 400 });
});
it('orders block against concurrent direct creation and preserves shared group authorization', async () => {
  const a = await user('blockrace'), b = await user('blockpeer');
  const results = await Promise.allSettled([service.createDirect(a.token, b.id), service.setBlock(b.token, a.id, true)]);
  expect(results[1]!.status).toBe('fulfilled'); await forbidden(service.createDirect(a.token, b.id));
  await service.setBlock(b.token, a.id, false); const id = await group(a); await join(a, b, id); await service.setBlock(a.token, b.id, true);
  expect(await service.authorizedOperation(b.token, id, async () => 'allowed')).toBe('allowed');
});
it('discovers conversations and removal through per-user inbox feeds with exact stable cursors', async () => {
  const a = await user('inboxowner'), b = await user('inboxmember');
  const initial = inboxSnapshotSchema.parse(await service.inbox(b.token, undefined, 1));
  const id = await group(a); await service.invite(a.token, id, b.id);
  const hints = inboxFeedSchema.parse(await service.inboxFeed(b.token, initial.watermark, undefined, 1)); expect(hints.events[0]!.conversationId).toBe(id);
  expect((await service.inbox(b.token, undefined, 1)).items[0]!.state).toBe('invited'); await service.respondInvitation(b.token, id, true);
  await service.remove(a.token, id, b.id); expect((await service.inbox(b.token, undefined, 10)).items).toEqual([]);
  const first = await service.inboxFeed(b.token, initial.watermark, undefined, 1); const next = await service.inboxFeed(b.token, first.nextCursor, first.watermark, 10);
  expect(next.events).toHaveLength(2); expect(BigInt(next.events[0]!.sequence)).toBeGreaterThan(BigInt(first.nextCursor));
  await db.collection<InboxCounter>('inboxCounters').updateOne({ _id: b.id }, { $set: { sequence: Long.fromString('9007199254740993') } });
  await service.setBlock(a.token, b.id, true); expect((await service.inbox(b.token, undefined, 1)).watermark).toBe('9007199254740994');
});
it('uses indexed exact Long history cursors and visibility intervals across removal and rejoin', async () => {
  const a = await user('historyowner'), b = await user('historymember'), id = await group(a);
  // Test-only durable message fixtures: the product has no send command until Phase 03.
  async function fixture(text: string, deleted = false) {
    const c = await db.collection<ConversationRecord>('conversations').findOneAndUpdate({ _id: id }, { $inc: { nextEventSeq: Long.ONE } }, { returnDocument: 'after' });
    await db.collection<MessageRecord>('messages').insertOne({ _id: randomUUID(), schemaVersion: 1, conversationId: id, senderId: a.id, clientMessageId: randomUUID(), originalDigest: 'test-fixture', creationSeq: c!.nextEventSeq, text, deletedAt: deleted ? new Date() : null, createdAt: new Date() });
  }
  await fixture('before join'); await join(a, b, id); await fixture('visible before leave'); await service.remove(a.token, id, b.id); await fixture('during absence');
  await join(a, b, id); await db.collection<ConversationRecord>('conversations').updateOne({ _id: id }, { $set: { nextEventSeq: Long.fromString('9007199254740993') } });
  await fixture('after rejoin'); await fixture('deleted secret', true);
  const bounded = new ConversationService(new AuthService({ ...config, MAX_HISTORY_PAGE: 1 }, client, db));
  expect((await bounded.history(b.token, id, undefined, undefined, 100)).messages).toHaveLength(1);
  const first = historySchema.parse(await service.history(b.token, id, undefined, undefined, 1)); expect(first.messages[0]!.text).toBe(''); expect(first.messages[0]!.deleted).toBe(true); expect(first.messages[0]!.creationSequence).toBe('9007199254740995');
  await fixture('new after snapshot');
  const second = await service.history(b.token, id, first.nextCursor!, first.watermark, 1); const third = await service.history(b.token, id, second.nextCursor!, first.watermark, 1);
  expect(second.messages.map(m => m.text)).toEqual(['after rejoin']); expect(third.messages.map(m => m.text)).toEqual(['visible before leave']); expect(third.nextCursor).toBeNull();
  const plan = await db.collection('messages').find({ conversationId: id, creationSeq: { $lt: Long.MAX_VALUE } }).sort({ creationSeq: -1 }).explain('queryPlanner');
  expect(JSON.stringify(plan['queryPlanner'])).toContain('message_history_cursor');
});
it('serializes shared authorization writes before removal and denies all subsequent operations', async () => {
  const a = await user('guardowner'), b = await user('guardmember'), id = await group(a); await join(a, b, id);
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const operation = service.authorizedOperation(b.token, id, async ({ session }) => { entered(); await gate; await db.collection('guardEvidence').insertOne({ conversationId: id }, { session }); return true; });
  await ready; let removalFinished = false; const removal = service.remove(a.token, id, b.id).then(() => { removalFinished = true; });
  try { await new Promise(resolve => setTimeout(resolve, 150)); expect(removalFinished).toBe(false); } finally { release(); }
  expect(await operation).toBe(true); await removal; expect(await db.collection('guardEvidence').countDocuments({ conversationId: id })).toBe(1);
  await forbidden(service.authorizedOperation(b.token, id, async () => 'must not run'));
});
it('serializes shared direct authorization before a block and enforces the block after commit', async () => {
  const a = await user('guarddirect'), b = await user('guardblock'), id = (await service.createDirect(a.token, b.id)).conversationId;
  let release!: () => void, entered!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { entered = resolve; });
  const operation = service.authorizedOperation(a.token, id, async () => { entered(); await gate; return true; }); await ready;
  let finished = false; const block = service.setBlock(b.token, a.id, true).then(() => { finished = true; });
  try { await new Promise(resolve => setTimeout(resolve, 150)); expect(finished).toBe(false); } finally { release(); }
  expect(await operation).toBe(true); await block; await forbidden(service.authorizedOperation(a.token, id, async () => true));
});
it('enforces recipient inbox and block quotas under concurrent commands', async () => {
  const limitedAuth = new AuthService({ ...config, MAX_GROUP_MEMBERS: 1, MAX_CONVERSATIONS_PER_USER: 1, MAX_BLOCKS_PER_USER: 1 }, client, db), limited = new ConversationService(limitedAuth);
  const a = await user('limitowner'), b = await user('limitpeer'), c = await user('limitthird');
  const results = await Promise.allSettled([limited.createDirect(a.token, b.id), limited.createDirect(a.token, c.id)]); expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  const blocks = await Promise.allSettled([limited.setBlock(b.token, a.id, true), limited.setBlock(b.token, c.id, true)]); expect(blocks.filter(r => r.status === 'fulfilled')).toHaveLength(1);
});
it('rolls back conversation, membership and inbox state if durable event admission fails', async () => {
  const a = await user('rollback'), constrained = new ConversationService(new AuthService({ ...config, MAX_PENDING_OUTBOX: 1 }, client, db));
  const before = await service.inbox(a.token, undefined, 10), commands = await db.collection('conversationCommands').countDocuments({ userId: a.id });
  await expect(constrained.createGroup(a.token, randomUUID(), 'Must roll back')).rejects.toMatchObject({ status: 503 });
  expect(await service.inbox(a.token, undefined, 10)).toEqual(before);
  expect(await db.collection('memberships').countDocuments({ userId: a.id })).toBe(0);
  expect(await db.collection('conversationCommands').countDocuments({ userId: a.id })).toBe(commands);
  expect(await db.collection('conversations').countDocuments({ title: 'Must roll back' })).toBe(0);
});
it('paginates inbox and block lists with unique indexed keysets', async () => {
  const a = await user('pages'), b = await user('pageb'), c = await user('pagec');
  const ids = [await group(a, 'Page one'), await group(a, 'Page two'), await group(a, 'Page three')];
  const seen: string[] = []; let cursor: string | undefined;
  do { const page = await service.inbox(a.token, cursor, 1); seen.push(...page.items.map(item => item.id)); cursor = page.nextCursor ?? undefined; } while (cursor);
  expect(seen).toEqual(ids.sort()); expect(new Set(seen).size).toBe(3);
  await service.setBlock(a.token, b.id, true); await service.setBlock(a.token, c.id, true);
  const first = await service.listBlocks(a.token, undefined, 1), second = await service.listBlocks(a.token, first.nextCursor!, 1);
  expect([...first.users, ...second.users].map(u => u.id)).toEqual([b.id, c.id].sort()); expect(second.nextCursor).toBeNull();
});
it('rejects concurrent migration leases, recovers expiration and preserves strict validators', async () => {
  const locks = db.collection<{ _id: string; owner: string | null; leaseUntil: Date; epoch: number }>('migrationLocks');
  await locks.updateOne({ _id: 'schema' }, { $set: { owner: 'test-holder', leaseUntil: new Date(Date.now() + 60000) } });
  await expect(runMigrations(db)).rejects.toThrow('Another schema migration');
  await locks.updateOne({ _id: 'schema' }, { $set: { leaseUntil: new Date(0) } }); await runMigrations(db);
  await expect(db.collection('memberships').insertOne({ conversationId: randomUUID(), role: 'administrator' })).rejects.toMatchObject({ code: 121 });
  expect((await locks.findOne({ _id: 'schema' }))!.owner).toBeNull();
});
