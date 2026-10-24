import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { Long } from 'mongodb';
import { SyncService, FanoutWorker, OutboxRelay, EventConsumer, BrokerTransport } from '@chat/domain';
import type { ReplayFloor, SnapshotRecord } from '@chat/domain';
import { createGateway } from '@chat/gateway';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { messagingFixture, command, waitFor, cleanBroker } from './messaging-fixture.js';
let f: Awaited<ReturnType<typeof messagingFixture>>, sync: SyncService, first: Awaited<ReturnType<typeof createGateway>>, second: Awaited<ReturnType<typeof createGateway>>;
const sockets: Socket[] = [];
it('personal deletion persists across sessions, invalidates captured views and denies hidden mutations without changing peers', async () => {
  const a = await f.user('privatehidea'), b = await f.user('privatehideb'), id = (await sync.createDirect(a.token, b.id)).conversationId;
  const sent = await sync.send(a.token, command(id, 'Only hide my copy')), messageId = sent.message.messageId;
  await sync.mutate(a.token, { kind: 'pin', commandId: randomUUID(), conversationId: id, messageId, active: true });
  const old = await sync.createSnapshot(b.token, 'conversation', id), oldInbox = await sync.createSnapshot(b.token, 'inbox');
  const hide = { kind: 'hide' as const, commandId: randomUUID(), conversationId: id, messageId };
  const accepted = await sync.mutate(b.token, hide); expect(await sync.mutate(b.token, hide)).toEqual(accepted);
  expect((await sync.snapshot(b.token, id)).messages).toHaveLength(0); expect((await sync.snapshot(b.token, id)).pinnedMessages).toHaveLength(0);
  expect((await sync.history(b.token, id, undefined, undefined, 100)).messages).toHaveLength(0);
  expect((await sync.snapshot(a.token, id)).messages[0]).toMatchObject({ text: 'Only hide my copy', pinned: true, deleted: false });
  await expect(sync.snapshotPage(b.token, old.id, 0)).rejects.toMatchObject({ status: 403 }); await expect(sync.snapshotPage(b.token, oldInbox.id, 0)).rejects.toMatchObject({ status: 403 });
  await expect(sync.mutate(b.token, { ...hide, messageId: randomUUID() })).rejects.toMatchObject({ status: 409 });
  await expect(sync.mutate(b.token, { kind: 'pin', commandId: randomUUID(), conversationId: id, messageId, active: true })).rejects.toMatchObject({ status: 403 });
  await expect(sync.send(b.token, { ...command(id, 'Reply to hidden copy'), replyToId: messageId })).rejects.toMatchObject({ status: 403 });
  const ticket = await sync.createSnapshot(b.token, 'inbox'); const inbox = await sync.snapshotPage(b.token, ticket.id, 0); expect((inbox.data as { id: string; unread: number }[]).find(row => row.id === id)?.unread).toBe(0);
});
it('shared pins retain visibility boundaries and require group manager authority, with idempotent unpinning', async () => {
  const a = await f.user('pina'), b = await f.user('pinb'), id = (await sync.createGroup(a.token, randomUUID(), 'Shared pins')).conversationId;
  const old = await sync.send(a.token, command(id, 'Before invitation'));
  await sync.mutate(a.token, { kind: 'pin', commandId: randomUUID(), conversationId: id, messageId: old.message.messageId, active: true });
  await sync.invite(a.token, id, b.id); await sync.respondInvitation(b.token, id, true);
  expect((await sync.snapshot(b.token, id)).pinnedMessages).toHaveLength(0);
  const newer = await sync.send(a.token, command(id, 'Visible pin')), pin = { kind: 'pin' as const, commandId: randomUUID(), conversationId: id, messageId: newer.message.messageId, active: true };
  await expect(sync.mutate(b.token, pin)).rejects.toMatchObject({ status: 403 });
  const result = await sync.mutate(a.token, pin); expect(await sync.mutate(a.token, pin)).toEqual(result);
  expect((await sync.snapshot(b.token, id)).pinnedMessages.map(row => row.text)).toEqual(['Visible pin']);
  await sync.mutate(a.token, { kind: 'edit', commandId: randomUUID(), conversationId: id, messageId: newer.message.messageId, expectedVersion: '0', text: 'Edited pinned message' });
  expect((await sync.snapshot(b.token, id)).pinnedMessages[0]?.text).toBe('Edited pinned message');
  await sync.mutate(a.token, { ...pin, commandId: randomUUID(), active: false }); expect((await sync.snapshot(b.token, id)).pinnedMessages).toHaveLength(0);
  await sync.mutate(a.token, pin); expect((await sync.snapshot(b.token, id)).pinnedMessages).toHaveLength(0);
  await sync.manage(b.token, id, randomUUID(), 'clear'); expect((await sync.snapshot(b.token, id)).messages).toHaveLength(0);
});
it('keeps pin/archive preferences account-private, invalidates inbox captures and never replays an old preference over a later choice', async () => {
  const a = await f.user('prefa'), b = await f.user('prefb'), outsider = await f.user('prefout'), id = (await sync.createDirect(a.token, b.id)).conversationId;
  const old = await sync.createSnapshot(a.token, 'inbox'), pin = randomUUID(), archive = randomUUID();
  await sync.preference(a.token, id, pin, 'pin-chat', true); await sync.preference(a.token, id, archive, 'archive-chat', true);
  expect(await sync.detail(a.token, id)).toMatchObject({ pinned: true, archived: true }); expect(await sync.detail(b.token, id)).toMatchObject({ pinned: false, archived: false });
  expect((await sync.inbox(a.token, undefined, 100)).items.find(row => row.id === id)).toMatchObject({ pinned: true, archived: true });
  await expect(sync.snapshotPage(a.token, old.id, 0)).rejects.toMatchObject({ status: 403 });
  await sync.preference(a.token, id, randomUUID(), 'pin-chat', false); await sync.preference(a.token, id, pin, 'pin-chat', true); expect((await sync.detail(a.token, id)).pinned).toBe(false);
  await expect(sync.preference(a.token, id, archive, 'archive-chat', false)).rejects.toMatchObject({ status: 409 });
  await expect(sync.preference(outsider.token, id, randomUUID(), 'pin-chat', true)).rejects.toMatchObject({ status: 403 });
  await sync.manage(a.token, id, randomUUID(), 'delete'); expect(await f.db.collection('memberships').findOne({ conversationId: id, userId: a.id })).not.toHaveProperty('pinned'); expect(await f.db.collection('memberships').findOne({ conversationId: id, userId: a.id })).not.toHaveProperty('archived');
});
beforeAll(async () => { f = await messagingFixture('sync_test', { SESSION_RECHECK_SECONDS: '1' }); sync = new SyncService(f.auth); first = await createGateway(f.config, 0); second = await createGateway(f.config, 0); });
afterAll(async () => { for (const socket of sockets) socket.disconnect(); if (first) await first.close(); if (second) await second.close(); if (f) { await cleanBroker(f); await f.close(); } });
async function socket(url: string, actor: Awaited<ReturnType<typeof f.user>>, origin = f.config.WEB_ORIGIN, csrf = actor.csrf) {
  const client = io(url, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { csrf }, extraHeaders: { Origin: origin, Cookie: `commonroom_session=${actor.token}` }, timeout: 3000 }); sockets.push(client);
  await new Promise<void>((resolve, reject) => { client.once('connect', resolve); client.once('connect_error', reject); });
  client.on('sync:hint', (_hint, ack: () => void) => ack()); return client;
}
it('captures versioned projections, commits edits/reactions/deletes atomically and preserves original send result', async () => {
  const a = await f.user('edita'), b = await f.user('editb'), id = (await sync.createDirect(a.token, b.id)).conversationId, original = command(id, 'Original');
  const sent = await sync.send(a.token, original), edit = { kind: 'edit' as const, commandId: randomUUID(), conversationId: id, messageId: sent.message.messageId, expectedVersion: '0', text: 'Edited for real' };
  const changed = await sync.mutate(a.token, edit); expect(await sync.mutate(a.token, edit)).toEqual(changed);
  await expect(sync.mutate(b.token, { ...edit, commandId: randomUUID() })).rejects.toMatchObject({ status: 403 });
  await expect(sync.mutate(a.token, { ...edit, commandId: randomUUID() })).rejects.toMatchObject({ status: 409 });
  await sync.mutate(b.token, { kind: 'reaction', commandId: randomUUID(), conversationId: id, messageId: sent.message.messageId, reaction: 'like', active: true });
  let snapshot = await sync.snapshot(a.token, id); expect(snapshot.messages[0]!.text).toBe('Edited for real'); expect(snapshot.messages[0]!.version).toBe('1'); expect(snapshot.messages[0]!.reactions[0]!.count).toBe(1);
  expect(await sync.send(a.token, original)).toEqual(sent);
  await sync.mutate(a.token, { kind: 'delete', commandId: randomUUID(), conversationId: id, messageId: sent.message.messageId, expectedVersion: '1' });
  snapshot = await sync.snapshot(b.token, id); expect(snapshot.messages[0]).toMatchObject({ deleted: true, text: '', reactions: [] });
  expect(await sync.send(a.token, original)).toEqual(sent);
});
it('advances replay across invisible intervals without exposing their references and handles floor expiry', async () => {
  const a = await f.user('replaya'), b = await f.user('replayb'), id = (await sync.createGroup(a.token, randomUUID(), 'Replay windows')).conversationId;
  const hidden = await sync.send(a.token, command(id, 'Before join')); await sync.invite(a.token, id, b.id); await sync.respondInvitation(b.token, id, true); const visible = await sync.send(a.token, command(id, 'After join'));
  let cursor = '0'; const ids: string[] = [];
  for (let page = 0; page < 20; page++) { const result = await sync.replay(b.token, id, cursor, undefined, 1); ids.push(...result.events.map(event => event.eventId)); expect(BigInt(result.nextCursor)).toBeGreaterThanOrEqual(BigInt(cursor)); cursor = result.nextCursor; if (!result.hasMore) break; }
  expect(ids).not.toContain(hidden.eventId); expect(ids).toContain(visible.eventId);
  await f.db.collection<ReplayFloor>('replayFloors').insertOne({ _id: id, schemaVersion: 1, floor: Long.ONE, createdAt: new Date() });
  await expect(sync.replay(b.token, id, '0')).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
});
it('pins user-bound expiring snapshots and serializes snapshot quota', async () => {
  const a = await f.user('snapa'), b = await f.user('snapb'), id = (await sync.createDirect(a.token, b.id)).conversationId;
  await sync.send(a.token, command(id, 'Pinned')); const ticket = await sync.createSnapshot(a.token, 'conversation', id);
  await sync.send(a.token, command(id, 'Later')); const page = await sync.snapshotPage(a.token, ticket.id, 0);
  expect((page.data as { messages: unknown[] }).messages).toHaveLength(1); expect(page.watermark).toBe(ticket.watermark);
  await expect(sync.snapshotPage(b.token, ticket.id, 0)).rejects.toMatchObject({ status: 403 });
  const races = await Promise.allSettled(Array.from({ length: 5 }, () => sync.createSnapshot(a.token, 'inbox'))); expect(races.filter(result => result.status === 'fulfilled')).toHaveLength(3);
  await f.db.collection<SnapshotRecord>('syncSnapshots').updateOne({ _id: ticket.id }, { $set: { expiresAt: new Date(0) } }); await expect(sync.snapshotPage(a.token, ticket.id, 0)).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
});
it('keeps receipt progress monotonic and rejects future or inverted positions', async () => {
  const a = await f.user('receipta'), b = await f.user('receiptb'), id = (await sync.createDirect(a.token, b.id)).conversationId;
  const sent = await sync.send(a.token, command(id)), sequence = sent.message.creationSequence;
  const mutation = { kind: 'receipt' as const, appliedFrom: '0', commandId: randomUUID(), conversationId: id, delivered: sequence, read: sequence };
  await sync.mutate(b.token, mutation); await sync.mutate(b.token, { ...mutation, commandId: randomUUID(), delivered: '0', read: '0' });
  expect((await sync.snapshot(a.token, id)).receipts.find(row => row.userId === b.id)).toMatchObject({ delivered: sequence, read: sequence });
  await expect(sync.mutate(b.token, { ...mutation, commandId: randomUUID(), delivered: '999' })).rejects.toMatchObject({ status: 400 });
  await expect(sync.mutate(b.token, { ...mutation, commandId: randomUUID(), delivered: '0', read: '1' })).rejects.toMatchObject({ status: 400 });
});
it('rejects unverified/forged socket handshakes and unauthorized subscriptions', async () => {
  const a = await f.user('socketa'), outsider = await f.user('socketout'), pending = await f.user('socketpending', false), id = (await sync.createGroup(a.token, randomUUID(), 'Socket access')).conversationId;
  await expect(socket(first.url, a, 'https://evil.example')).rejects.toThrow(); await expect(socket(first.url, a, f.config.WEB_ORIGIN, 'x'.repeat(32))).rejects.toThrow(); await expect(socket(first.url, pending)).rejects.toThrow();
  const client = await socket(first.url, outsider); expect(await client.timeout(5000).emitWithAck('sync:subscribe', { conversationId: id })).toEqual({ ok: false });
  expect(await client.timeout(5000).emitWithAck('sync:subscribe', { conversationId: id, senderId: a.id })).toEqual({ ok: false });
});
it('enforces a distributed per-session connection quota across two actual gateways', async () => {
  const a = await f.user('quotasocket'), open = [];
  for (let index = 0; index < f.config.MAX_CONNECTIONS_PER_SESSION; index++) open.push(await socket(index % 2 ? first.url : second.url, a));
  await expect(socket(second.url, a)).rejects.toThrow(); for (const client of open) client.disconnect();
});
it('bounds concurrent protected socket commands before doing dependency work', async () => {
  const actor = await f.user('socketpressure'), id = (await sync.createGroup(actor.token, randomUUID(), 'Command pressure')).conversationId, client = await socket(first.url, actor);
  const results = await Promise.all(Array.from({ length: 20 }, () => client.timeout(5000).emitWithAck('sync:subscribe', { conversationId: id })));
  expect(results.filter(result => result.ok).length).toBeGreaterThan(0); expect(results.filter(result => result.ok).length).toBeLessThanOrEqual(4);
  expect(results.filter(result => !result.ok).length).toBeGreaterThanOrEqual(16); client.disconnect();
});
it('publishes committed hints through Rabbit, a leased fanout job, Redis adapter and both gateways', async () => {
  const a = await f.user('livea'), b = await f.user('liveb'), id = (await sync.createDirect(a.token, b.id)).conversationId;
  const one = await socket(first.url, a), two = await socket(second.url, b); await one.timeout(5000).emitWithAck('sync:subscribe', { conversationId: id }); await two.timeout(5000).emitWithAck('sync:subscribe', { conversationId: id });
  let receivedOne = false, receivedTwo = false; one.on('sync:hint', hint => { if (hint.conversationId === id) receivedOne = true; }); two.on('sync:hint', hint => { if (hint.conversationId === id) receivedTwo = true; });
  await sync.send(a.token, command(id, 'Across gateways'));
  const broker = await BrokerTransport.open(f.config), consumer = new EventConsumer(sync, broker, 'fanout'), relay = new OutboxRelay(sync, broker), fanout = new FanoutWorker(f.db, f.config);
  try { await consumer.start(); while (await relay.runOnce()) { /* drain bounded fixture */ } await waitFor(async () => await f.db.collection('fanoutJobs').countDocuments({ state: 'pending' }) >= 2);
    while (await fanout.runOnce()) { /* drain bounded fixture */ } await waitFor(async () => receivedOne && receivedTwo);
  } finally { one.disconnect(); two.disconnect(); await consumer.stop(); await fanout.close(); await broker.close(); }
});
it('disconnects a revoked session by its authoritative recheck and protects replay after removal', async () => {
  const a = await f.user('revokesocket'), b = await f.user('removedsocket'), id = (await sync.createGroup(a.token, randomUUID(), 'Removal')).conversationId;
  await sync.invite(a.token, id, b.id); await sync.respondInvitation(b.token, id, true); const client = await socket(first.url, b);
  await sync.remove(a.token, id, b.id); await expect(sync.snapshot(b.token, id)).rejects.toMatchObject({ status: 403 });
  await f.auth.revoke(b.token, 'all'); await waitFor(async () => !client.connected, 5000);
});

it('pins a multi-page inbox while earlier-key inserts and title changes continue, and expires inbox cursors explicitly', async () => {
  const actor = await f.user('manyinbox'), ids: string[] = [];
  for (let index = 0; index < 101; index++) ids.push((await sync.createGroup(actor.token, randomUUID(), `Pinned ${index}`)).conversationId);
  const ticket = await sync.createSnapshot(actor.token, 'inbox'), firstPage = await sync.snapshotPage(actor.token, ticket.id, 0);
  expect(firstPage.data).toHaveLength(100); expect(firstPage.nextPage).toBe(1);
  const added = await sync.createGroup(actor.token, randomUUID(), 'New during capture'); await sync.rename(actor.token, ids[0]!, 'Changed during capture');
  const lastPage = await sync.snapshotPage(actor.token, ticket.id, 1), pinned = [...firstPage.data as { id: string; title: string }[], ...lastPage.data as { id: string; title: string }[]];
  expect(pinned).toHaveLength(101); expect(pinned.some(row => row.id === added.conversationId)).toBe(false); expect(pinned.some(row => row.title === 'Changed during capture')).toBe(false);
  const feed = await sync.inboxFeed(actor.token, ticket.watermark, undefined, 100); expect(feed.events.map(row => row.conversationId)).toContain(added.conversationId);
  const connected = await socket(first.url, actor);
  await f.db.collection<ReplayFloor>('replayFloors').insertOne({ _id: `inbox:${actor.id}`, schemaVersion: 1, floor: Long.ONE, createdAt: new Date() });
  await expect(sync.inboxFeed(actor.token, '0', undefined, 100)).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' });
  await new Promise(resolve => setTimeout(resolve, 1500)); expect(connected.connected).toBe(true); connected.disconnect();
});

it('counts only unread visible incoming messages and merges contiguous applied delivery ranges under concurrent devices', async () => {
  const a = await f.user('unreada'), b = await f.user('unreadb'), id = (await sync.createDirect(a.token, b.id)).conversationId;
  const one = await sync.send(b.token, command(id, 'One')), two = await sync.send(b.token, command(id, 'Two')); await sync.send(a.token, command(id, 'Own message'));
  async function unread() { const ticket = await sync.createSnapshot(a.token, 'inbox'); try { const page = await sync.snapshotPage(a.token, ticket.id, 0); return (page.data as { id: string; unread: number }[]).find(row => row.id === id)!.unread; } finally { await f.db.collection<SnapshotRecord>('syncSnapshots').deleteOne({ _id: ticket.id }); } }
  expect(await unread()).toBe(2);
  await sync.mutate(b.token, { kind: 'edit', commandId: randomUUID(), conversationId: id, messageId: one.message.messageId, expectedVersion: '0', text: 'Edited one' });
  await sync.mutate(a.token, { kind: 'reaction', commandId: randomUUID(), conversationId: id, messageId: one.message.messageId, reaction: 'heart', active: true }); expect(await unread()).toBe(2);
  const receipt = { kind: 'receipt' as const, commandId: randomUUID(), conversationId: id, appliedFrom: two.message.creationSequence, delivered: two.message.creationSequence, read: one.message.creationSequence };
  await sync.mutate(a.token, receipt); expect(await unread()).toBe(1);
  let stored = (await sync.snapshot(b.token, id)).receipts.find(row => row.userId === a.id)!; expect(stored.deliveredFrom).toBe(two.message.creationSequence);
  await Promise.all([
    sync.mutate(a.token, { ...receipt, commandId: randomUUID(), appliedFrom: one.message.creationSequence, read: two.message.creationSequence }),
    sync.mutate(a.token, { ...receipt, commandId: randomUUID(), appliedFrom: one.message.creationSequence, delivered: one.message.creationSequence, read: '0' })
  ]);
  stored = (await sync.snapshot(b.token, id)).receipts.find(row => row.userId === a.id)!; expect(stored).toMatchObject({ delivered: two.message.creationSequence, deliveredFrom: one.message.creationSequence, read: two.message.creationSequence }); expect(await unread()).toBe(0);
});

it('paginates versioned history in bounded windows and rejects blocked mutations after the shared guard commits', async () => {
  const a = await f.user('bounda'), b = await f.user('boundb'), id = (await sync.createDirect(a.token, b.id)).conversationId;
  for (let index = 0; index < 103; index++) await sync.send(a.token, command(id, `Window ${index}`));
  const latest = await sync.snapshot(b.token, id); expect(latest.messages).toHaveLength(100); expect(latest.olderBefore).not.toBeNull();
  const older = await sync.snapshot(b.token, id, latest.olderBefore!); expect(older.messages).toHaveLength(3); expect(older.olderBefore).toBeNull();
  expect(new Set([...latest.messages, ...older.messages].map(row => row.id)).size).toBe(103);
  const last = latest.messages[0]!; await sync.setBlock(b.token, a.id, true);
  await expect(sync.mutate(a.token, { kind: 'edit', commandId: randomUUID(), conversationId: id, messageId: last.id, expectedVersion: last.version, text: 'Forbidden after block' })).rejects.toMatchObject({ status: 403 });
  expect((await sync.snapshot(a.token, id)).messages[0]!.text).toBe(last.text);
});

it('aggregates real per-device presence, respects privacy and suppresses typing after blocking', async () => {
  const a = await f.user('presencea'), b = await f.user('presenceb'), id = (await sync.createDirect(a.token, b.id)).conversationId;
  const one = await socket(first.url, a), two = await socket(second.url, b); await one.timeout(3000).emitWithAck('sync:subscribe', { conversationId: id }); await two.timeout(3000).emitWithAck('sync:subscribe', { conversationId: id });
  let typing = 0; two.on('sync:typing', () => { typing++; }); one.emit('sync:typing', { conversationId: id, active: true }); await waitFor(async () => typing > 0);
  await waitFor(async () => (await one.timeout(3000).emitWithAck('sync:presence', { conversationId: id, targetUserId: b.id })).online === true);
  await f.db.collection<{ _id: string; privacy: { showPresence: boolean } }>('users').updateOne({ _id: b.id }, { $set: { 'privacy.showPresence': false } });
  expect(await one.timeout(3000).emitWithAck('sync:presence', { conversationId: id, targetUserId: b.id })).toEqual({ ok: true, online: null });
  await sync.setBlock(b.token, a.id, true); const previous = typing; one.emit('sync:typing', { conversationId: id, active: true }); await new Promise(resolve => setTimeout(resolve, 400)); expect(typing).toBe(previous);
  expect(await one.timeout(3000).emitWithAck('sync:presence', { conversationId: id, targetUserId: b.id })).toEqual({ ok: false }); one.disconnect(); two.disconnect();
});
