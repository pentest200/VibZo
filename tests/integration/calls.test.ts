import { randomUUID, createHash } from 'node:crypto';
import { beforeAll, afterAll, beforeEach, expect, it } from 'vitest';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { createApi } from '@chat/api';
import { CallService, CallWorker, LiveKitProvider, SafetyService, SafetyMaintenance, SyncService, runMigrations } from '@chat/domain';
import { messagingFixture } from './messaging-fixture.js';
import type { DeletionJob } from '@chat/domain';

let f: Awaited<ReturnType<typeof messagingFixture>>, calls: CallService, worker: CallWorker, sync: SyncService;
const action = (action: string, targetUserId?: string) => ({ commandId: randomUUID(), action, ...(targetUserId ? { targetUserId } : {}) });
beforeAll(async () => {
  f = await messagingFixture('calls_test', { CALLS_ENABLED: 'true', MAX_CALL_PARTICIPANTS: '2' });
  calls = new CallService(f.auth); worker = new CallWorker(calls); sync = new SyncService(f.auth);
  expect(await calls.provider.health()).toBe(true);
});
afterAll(async () => {
  if (calls) for (const room of await calls.rooms().find().toArray()) await calls.provider.removeRoom(room._id);
  if (f) await f.close();
});
async function step() {
  await calls.calls().updateMany({ open: true }, { $set: { availableAt: new Date(0), leaseUntil: new Date(0) } });
  await worker.runOnce();
}
beforeEach(async () => {
  if (!calls) return;
  for (const row of await calls.calls().find({ open: true }).toArray()) await calls.run(session => calls.ending(row, 'test', 'Fixture cleanup', 'ended', session));
  for (let i = 0; i < 20 && await calls.calls().countDocuments({ open: true }); i++) await step();
  expect(await calls.calls().countDocuments({ open: true })).toBe(0);
});
async function pair(label: string) { const a = await f.user(`${label}a`), b = await f.user(`${label}b`); return { a, b, id: (await sync.createDirect(a.token, b.id)).conversationId }; }
async function start(a: { token: string }, conversationId: string, mode: 'voice' | 'video' = 'voice') { return (await calls.start(a.token, { commandId: randomUUID(), conversationId, mode })).id; }
async function group(label: string) {
  const a = await f.user(`${label}a`), b = await f.user(`${label}b`), c = await f.user(`${label}c`), id = (await sync.createGroup(a.token, randomUUID(), 'Call group')).conversationId;
  for (const user of [b, c]) { await sync.invite(a.token, id, user.id); await sync.respondInvitation(user.token, id, true); }
  return { a, b, c, id };
}
async function signalingAccepted(token: string) {
  const url = new URL('/rtc', f.config.LIVEKIT_URL);
  url.search = new URLSearchParams({ access_token: token, sdk: 'js', version: '2.23.0', protocol: '15', auto_subscribe: '1' }).toString();
  return new Promise<boolean>(resolve => {
    const socket = new WebSocket(url), timeout = setTimeout(() => finish(false), 5000);
    let done = false;
    function finish(accepted: boolean) { if (done) return; done = true; clearTimeout(timeout); socket.close(); resolve(accepted); }
    socket.onopen = () => finish(true); socket.onerror = () => finish(false); socket.onclose = () => finish(false);
  });
}
it('applies additive 007 idempotently and rejects malformed records', async () => {
  const a = await f.user('migration'); await runMigrations(f.db);
  expect(await f.db.collection('schemaMigrations').countDocuments()).toBe(7);
  expect((await f.auth.current(a.token)).user.id).toBe(a.id);
  await expect(f.db.collection('calls').insertOne({ state: 'active' })).rejects.toMatchObject({ code: 121 });
});
it('serializes duplicate starts, input digests, one open call and visibility boundaries', async () => {
  const { a, b, id } = await pair('dedup'), input = { commandId: randomUUID(), conversationId: id, mode: 'voice' };
  const [first, retry] = await Promise.all([calls.start(a.token, input), calls.start(a.token, input)]);
  expect(first).toEqual(retry); expect(await calls.calls().countDocuments({ conversationId: id })).toBe(1);
  await expect(calls.start(a.token, { ...input, mode: 'video' })).rejects.toMatchObject({ status: 409 });
  await expect(start(b, id)).rejects.toMatchObject({ status: 409 });
  const outsider = await f.user('outsider'), unverified = await f.user('unverified', false);
  await expect(calls.get(outsider.token, first.id)).rejects.toMatchObject({ status: 403 });
  await expect(calls.start(unverified.token, { ...input, commandId: randomUUID() })).rejects.toMatchObject({ status: 403 });
  const view = await calls.get(b.token, first.id); expect(JSON.stringify(view)).not.toContain(a.email);
  expect(JSON.stringify(view)).not.toContain('_call_');
});
it('binds the first accepting device, enforces group capacity and excludes later members', async () => {
  const { a, b, c, id } = await group('capacity'), call = await start(a, id);
  const other = await f.auth.login({ email: b.email, password: 'Synthetic-messaging-password-123', deviceLabel: 'Second device' });
  const results = await Promise.allSettled([calls.action(b.token, call, action('accept')), calls.action(other.token, call, action('accept'))]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  await expect(calls.action(c.token, call, action('accept'))).rejects.toMatchObject({ status: 409 });
  const part = await calls.participants().findOne({ callId: call, userId: b.id });
  const current = await f.auth.current(b.token), loser = part!.sessionId === current.sessionId ? other.token : b.token;
  await step(); await expect(calls.join(loser, call)).rejects.toMatchObject({ status: 403 });
  const later = await f.user('later'); await sync.invite(a.token, id, later.id); await sync.respondInvitation(later.token, id, true);
  await expect(calls.get(later.token, call)).rejects.toMatchObject({ status: 403 });
  await expect(calls.action(later.token, call, action('accept'))).rejects.toMatchObject({ status: 403 });
});
it('resolves an accept/cancel race without admitting to a closing room', async () => {
  const { a, b, id } = await pair('race'), call = await start(a, id);
  const results = await Promise.allSettled([calls.action(a.token, call, action('cancel')), calls.action(b.token, call, action('accept'))]);
  expect(results.some(r => r.status === 'fulfilled')).toBe(true);
  const row = (await calls.calls().findOne({ _id: call }))!;
  if (row.state === 'active') await calls.action(a.token, call, action('end'));
  await expect(calls.join(b.token, call)).rejects.toMatchObject({ status: 403 });
  await step(); expect((await calls.get(a.token, call)).ready).toBe(false);
  expect(await calls.rooms().countDocuments({ callId: call, state: { $ne: 'deleted' } })).toBe(0);
});
it('creates a real bounded room and signs minimal scoped grants with issuance throttling', async () => {
  const { a, b, id } = await pair('grants'), call = await start(a, id, 'video');
  await expect(calls.join(a.token, call)).rejects.toMatchObject({ status: 503 });
  await calls.action(b.token, call, action('accept')); await step();
  const ticket = await calls.join(a.token, call), verifier = new TokenVerifier(f.config.LIVEKIT_API_KEY, f.config.LIVEKIT_API_SECRET);
  const claims = await verifier.verify(ticket.token);
  expect(claims.sub).toBe(ticket.identity); expect(ticket.identity).toMatch(new RegExp(`^${a.id}:`));
  expect(claims.exp! - claims.nbf!).toBeLessThanOrEqual(120);
  expect(claims.video).toMatchObject({ roomJoin: true, roomCreate: false, roomAdmin: false, roomList: false, roomRecord: false, canPublishData: false, canUpdateOwnMetadata: false });
  expect(claims.video!.canPublishSources).toContain('camera'); expect(JSON.stringify(claims)).not.toContain(a.email);
  const provider = calls.provider as LiveKitProvider, rooms = await provider.client.listRooms([claims.video!.room!]);
  expect(rooms).toHaveLength(1); expect(rooms[0]!.maxParticipants).toBe(2);
  await expect(calls.join(a.token, call)).rejects.toMatchObject({ status: 429 });
});
it('rotates after moderator removal and keeps old credentials out of the next incarnation', async () => {
  const { a, b, c, id } = await group('remove'), call = await start(a, id);
  await calls.action(b.token, call, action('accept')); await step();
  const old = await calls.join(b.token, call), previous = (await calls.calls().findOne({ _id: call }))!;
  expect(await signalingAccepted(old.token)).toBe(true);
  await expect(calls.action(b.token, call, action('remove', a.id))).rejects.toMatchObject({ status: 403 });
  await calls.action(a.token, call, action('remove', b.id));
  await expect(calls.join(a.token, call)).rejects.toMatchObject({ status: 503 });
  await step(); const fresh = await calls.join(a.token, call);
  expect(fresh.generation).toBe(old.generation + 1);
  expect(await calls.provider.participants(previous.roomName)).toBeNull();
  // A still-unexpired bearer cannot recreate the deleted room on the actual SFU.
  expect(await signalingAccepted(old.token)).toBe(false);
  await expect(calls.join(b.token, call)).rejects.toMatchObject({ status: 403 });
  await calls.action(c.token, call, action('accept'));
  expect((await calls.get(c.token, call)).participants.find(p => p.userId === c.id)?.state).toBe('accepted');
  const part = await calls.participants().findOne({ callId: call, userId: b.id }); expect(part!.roomGeneration).toBe(old.generation);
});
it('ends direct calls after session revocation or a pair block', async () => {
  for (const reason of ['session', 'block']) {
    const { a, b, id } = await pair(reason), call = await start(a, id); await calls.action(b.token, call, action('accept')); await step();
    if (reason === 'session') await f.auth.revoke(b.token, 'all'); else await sync.setBlock(b.token, a.id, true);
    await step(); expect(await calls.calls().findOne({ _id: call })).toMatchObject({ open: false, state: 'ended' });
    expect(await calls.rooms().countDocuments({ callId: call, state: { $ne: 'deleted' } })).toBe(0);
  }
});
it('retains failed provider cleanup durably and recovers after the real failed connection', async () => {
  const { a, id } = await pair('outage'), call = await start(a, id); await step();
  const down = new CallService(f.auth, new LiveKitProvider({ ...f.config, LIVEKIT_API_URL: 'http://127.0.0.1:1' }));
  expect(await down.status(a.token)).toEqual({ enabled: true, available: false });
  await expect(down.start(a.token, { commandId: randomUUID(), conversationId: id, mode: 'voice' })).rejects.toMatchObject({ status: 503 });
  await calls.action(a.token, call, action('cancel')); await new CallWorker(down).runOnce();
  expect(await calls.calls().findOne({ _id: call })).toMatchObject({ open: true, state: 'ending', failures: 1 });
  await expect(calls.join(a.token, call)).rejects.toMatchObject({ status: 403 });
  await step(); expect(await calls.calls().findOne({ _id: call })).toMatchObject({ open: false, failures: 0 });
});
it('reclaims a persisted provider-create result after an interrupted reconciliation', async () => {
  const { a, id } = await pair('reclaim'), call = await start(a, id);
  await new CallWorker(calls, async () => { throw new Error('Simulated loss after real provider create'); }).runOnce();
  expect(await calls.rooms().findOne({ callId: call })).toMatchObject({ state: 'pending' });
  const row = (await calls.calls().findOne({ _id: call }))!;
  expect(await calls.provider.participants(row.roomName)).toEqual([]);
  await step(); expect((await calls.get(a.token, call)).ready).toBe(true);
});
it('reconciles ringing, maximum-duration and empty-room deadlines without changing host time', async () => {
  for (const mode of ['ring', 'duration', 'empty']) {
    const { a, b, id } = await pair(mode), call = await start(a, id); await step();
    if (mode !== 'ring') await calls.action(b.token, call, action('accept'));
    await calls.calls().updateOne({ _id: call }, { $set: mode === 'ring' ? { ringUntil: new Date(0) } : mode === 'duration' ? { expiresAt: new Date(0) } : { emptySince: new Date(Date.now() - 31000) } });
    await step(); await step();
    expect(await calls.calls().findOne({ _id: call })).toMatchObject({ open: false, state: mode === 'ring' ? 'timed_out' : 'ended' });
  }
});
async function signature(raw: string) {
  const jwt = new AccessToken(f.config.LIVEKIT_API_KEY, f.config.LIVEKIT_API_SECRET, { ttl: 60 }); jwt.sha256 = createHash('sha256').update(raw).digest('base64'); return jwt.toJwt();
}
it('verifies exact raw HTTP webhook bytes, deduplicates, and treats stale events only as wakeups', async () => {
  const { a, id } = await pair('webhook'), call = await start(a, id), row = (await calls.calls().findOne({ _id: call }))!;
  const api = await createApi(f.config); await api.app.getHttpAdapter().getInstance().ready();
  try {
    const raw = JSON.stringify({ event: 'participant_left', id: `EV_${randomUUID()}`, room: { name: row.roomName }, participant: { identity: 'never-authoritative' } }), authorization = await signature(raw);
    const send = (payload: string | Buffer, auth = authorization, type = 'application/webhook+json') => api.app.inject({ method: 'POST', url: '/api/v1/webhooks/livekit', headers: { 'content-type': type, authorization: auth }, payload });
    expect((await send(raw)).statusCode).toBe(200); expect((await send(raw)).statusCode).toBe(200);
    expect((await send(raw + ' ')).statusCode).toBe(403);
    expect((await send(raw, 'forged')).statusCode).toBe(403);
    const unicode = raw.replace('never-authoritative', '\uFFFD'), bytes = Buffer.from(unicode), at = bytes.indexOf(Buffer.from('\uFFFD'));
    const lossy = Buffer.concat([bytes.subarray(0, at), Buffer.from([255]), bytes.subarray(at + 3)]);
    expect((await send(lossy, await signature(unicode))).statusCode).toBe(403);
    const changed = raw.replace('participant_left', 'participant_joined'); expect((await send(changed, await signature(changed))).statusCode).toBe(409);
    const jsonRaw = raw.replace(/EV_/, 'EV_json_'); expect((await send(jsonRaw, await signature(jsonRaw), 'application/json')).statusCode).toBe(200);
    expect(await f.db.collection('callWebhookInbox').countDocuments({ roomName: row.roomName })).toBe(2);
    expect(JSON.stringify(await f.db.collection('callWebhookInbox').find().toArray())).not.toContain('never-authoritative');
    await worker.webhookOnce(); await step(); expect((await calls.get(a.token, call)).state).toBe('ringing');
    const cookies = `commonroom_session=${a.token}`;
    const protectedCall = await api.app.inject({ method: 'POST', url: '/api/v1/calls', headers: { cookie: cookies, 'content-type': 'application/json', origin: f.config.WEB_ORIGIN }, payload: { commandId: randomUUID(), conversationId: id, mode: 'voice' } });
    expect(protectedCall.statusCode).toBe(403);
  } finally { await api.close(); }
});
it('keeps account deletion pending until rooms authorized to that account are really deleted', async () => {
  const { a, b, id } = await pair('delete'), call = await start(a, id); await calls.action(b.token, call, action('accept')); await step(); await calls.join(b.token, call);
  const safety = new SafetyService(f.auth), maintenance = new SafetyMaintenance(safety);
  await safety.requestDeletion(b.token, { password: 'Synthetic-messaging-password-123', confirmation: 'DELETE' });
  for (let i = 0; i < 5; i++) { await f.db.collection('accountDeletionJobs').updateMany({}, { $set: { availableAt: new Date(0) } }); await maintenance.deletionOnce(); }
  expect(await f.db.collection<DeletionJob>('accountDeletionJobs').findOne({ _id: b.id })).toMatchObject({ state: 'pending' });
  await step();
  for (let i = 0; i < 5; i++) { await f.db.collection('accountDeletionJobs').updateMany({}, { $set: { availableAt: new Date(0) } }); await maintenance.deletionOnce(); }
  expect(await f.db.collection<DeletionJob>('accountDeletionJobs').findOne({ _id: b.id })).toMatchObject({ state: 'done' });
});
