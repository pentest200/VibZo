import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { Long } from 'mongodb';
import { createApi } from '@chat/api';
import { acceptedMessageSchema } from '@chat/contracts';
import { AuthService, MessageService, migrateAuth, runMigrations } from '@chat/domain';
import { migrateConversations } from '../../packages/domain/src/conversations/migrations.js';
import type { ControlEvent, ConversationRecord, MessageRecord, OutboxRecord } from '@chat/domain';
import { messagingFixture, command } from './messaging-fixture.js';
let f: Awaited<ReturnType<typeof messagingFixture>>, api: Awaited<ReturnType<typeof createApi>>, base: string;
beforeAll(async () => { f = await messagingFixture('messaging_test'); api = await createApi(f.config); await api.app.listen(0, '127.0.0.1'); base = await api.app.getUrl(); });
afterAll(async () => { if (api) await api.close(); if (f) await f.close(); });
it('accepts only after durable message/event/outbox/inbox/command commit and rejects forged HTTP identity or CSRF', async () => {
  const a = await f.user('httpa'), b = await f.user('httpb'), stranger = await f.user('stranger'), pending = await f.user('pending', false);
  const id = (await f.service.createDirect(a.token, b.id)).conversationId, input = command(id);
  const send = (token: string, csrf: string, body: unknown) => fetch(`${base}/api/v1/messages`, { method: 'POST', headers: { Origin: f.config.WEB_ORIGIN, 'Content-Type': 'application/json', Cookie: `commonroom_session=${token}`, 'X-CSRF-Token': csrf }, body: JSON.stringify(body) });
  expect((await send(a.token, '', input)).status).toBe(403); expect((await send(a.token, a.csrf, { ...input, senderId: b.id })).status).toBe(400);
  expect((await send(stranger.token, stranger.csrf, input)).status).toBe(403); expect((await send(pending.token, pending.csrf, input)).status).toBe(403);
  const response = await send(a.token, a.csrf, input); expect(response.status).toBe(200); const result = acceptedMessageSchema.parse(await response.json());
  expect(await f.db.collection('messages').countDocuments({ conversationId: id })).toBe(1);
  expect(await f.db.collection<ControlEvent>('conversationEvents').countDocuments({ _id: result.eventId, kind: 'message.created' })).toBe(1);
  expect(await f.db.collection('outbox').countDocuments({ eventId: result.eventId, status: 'pending' })).toBe(1);
  expect(await f.db.collection('inboxEvents').countDocuments({ conversationId: id })).toBe(4);
  expect(await f.db.collection('messageCommands').countDocuments({ messageId: result.message.messageId })).toBe(1);
  // Deliberately discard the first result, then retry the original command as a lost-ACK reconciliation.
  expect(await f.service.send(a.token, input)).toEqual(result);
});
it('serializes identical concurrent sends, conflicts changed payload and keeps original result after edited text', async () => {
  const a = await f.user('duplicate'), id = (await f.service.createGroup(a.token, randomUUID(), 'Duplicates')).conversationId, input = command(id, 'Cafe\u0301\r\nhello');
  const results = await Promise.all([f.service.send(a.token, input), f.service.send(a.token, { ...input, text: 'Caf\u00e9\nhello' }), f.service.send(a.token, input)]);
  expect(results[1]).toEqual(results[0]); expect(results[2]).toEqual(results[0]);
  const result = results[0]!; expect(await f.db.collection('messages').countDocuments({ conversationId: id })).toBe(1);
  await expect(f.service.send(a.token, { ...input, text: 'different' })).rejects.toMatchObject({ status: 409 });
  await f.db.collection<MessageRecord>('messages').updateOne({ _id: result.message.messageId }, { $set: { text: 'Test fixture simulating a future edit' } });
  expect(await f.service.send(a.token, input)).toEqual(result); expect(result.message).not.toHaveProperty('text');
  const concurrent = command(id), competing = await Promise.allSettled([f.service.send(a.token, { ...concurrent, text: 'Left' }), f.service.send(a.token, { ...concurrent, text: 'Right' })]);
  expect(competing.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(competing.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
});
it('assigns contiguous exact Long sequences to concurrent messages above 2^53', async () => {
  const a = await f.user('sequence'), id = (await f.service.createGroup(a.token, randomUUID(), 'Sequences')).conversationId;
  await f.db.collection<ConversationRecord>('conversations').updateOne({ _id: id }, { $set: { nextEventSeq: Long.fromString('9007199254740993') } });
  const results = await Promise.all(Array.from({ length: 5 }, (_, index) => f.service.send(a.token, command(id, `Message ${index}`))));
  expect(results.map(result => BigInt(result.message.creationSequence)).sort((a, b) => a < b ? -1 : 1)).toEqual([9007199254740994n, 9007199254740995n, 9007199254740996n, 9007199254740997n, 9007199254740998n]);
});
it('rejects missing, foreign, deleted and invisible reply targets and unknown attachments', async () => {
  const a = await f.user('replyowner'), b = await f.user('replymember'), id = (await f.service.createGroup(a.token, randomUUID(), 'Reply visibility')).conversationId;
  const before = await f.service.send(a.token, command(id, 'Before membership')); await f.service.invite(a.token, id, b.id); await f.service.respondInvitation(b.token, id, true);
  await expect(f.service.send(b.token, { ...command(id), replyToId: before.message.messageId })).rejects.toMatchObject({ status: 403 });
  const visible = await f.service.send(a.token, command(id, 'Visible target')); const reply = await f.service.send(b.token, { ...command(id, 'Actual reply'), replyToId: visible.message.messageId });
  expect((await f.service.history(a.token, id, undefined, undefined, 10)).messages.find(message => message.id === reply.message.messageId)?.replyToId).toBe(visible.message.messageId);
  const foreign = (await f.service.createGroup(a.token, randomUUID(), 'Foreign')).conversationId;
  await expect(f.service.send(a.token, { ...command(foreign), replyToId: visible.message.messageId })).rejects.toMatchObject({ status: 403 });
  await f.db.collection<MessageRecord>('messages').updateOne({ _id: visible.message.messageId }, { $set: { deletedAt: new Date() } });
  await expect(f.service.send(a.token, { ...command(id), replyToId: visible.message.messageId })).rejects.toMatchObject({ status: 403 });
  await expect(f.service.send(a.token, { ...command(id), replyToId: randomUUID() })).rejects.toMatchObject({ status: 403 });
  await expect(f.service.send(a.token, { ...command(id), attachmentIds: [randomUUID()] })).rejects.toMatchObject({ status: 409 });
});
it('enforces normalization/length and rolls back every send effect if the sequence is exhausted', async () => {
  const a = await f.user('exhaust'), id = (await f.service.createGroup(a.token, randomUUID(), 'Exhausted')).conversationId;
  const bounded = new MessageService(new AuthService({ ...f.config, MAX_MESSAGE_CODEPOINTS: 3 }, f.client, f.db));
  await expect(bounded.send(a.token, command(id, 'four'))).rejects.toMatchObject({ status: 400 });
  await f.db.collection<ConversationRecord>('conversations').updateOne({ _id: id }, { $set: { nextEventSeq: Long.MAX_VALUE } });
  const before = await f.service.inbox(a.token, undefined, 100);
  await expect(f.service.send(a.token, command(id))).rejects.toMatchObject({ status: 409 });
  expect(await f.db.collection('messages').countDocuments({ conversationId: id })).toBe(0); expect(await f.db.collection('messageCommands').countDocuments({ conversationId: id })).toBe(0);
  expect(await f.service.inbox(a.token, undefined, 100)).toEqual(before); expect(await f.db.collection('conversationEvents').countDocuments({ conversationId: id })).toBe(1);
});
it('orders actual sends against removal/block and rejects later retries after permission loss', async () => {
  const a = await f.user('sendowner'), b = await f.user('sendmember'), id = (await f.service.createGroup(a.token, randomUUID(), 'Removal race')).conversationId;
  await f.service.invite(a.token, id, b.id); await f.service.respondInvitation(b.token, id, true);
  await Promise.allSettled([f.service.send(b.token, command(id, 'Racing removal')), f.service.remove(a.token, id, b.id)]);
  await expect(f.service.send(b.token, command(id))).rejects.toMatchObject({ status: 403 });
  const direct = (await f.service.createDirect(a.token, b.id)).conversationId, input = command(direct);
  await f.service.send(a.token, input); await Promise.allSettled([f.service.send(a.token, command(direct)), f.service.setBlock(b.token, a.id, true)]);
  await expect(f.service.send(a.token, input)).rejects.toMatchObject({ status: 403 });
});
it('bounds outbox admission globally across independent writers and rolls back rejected commands', async () => {
  const a = await f.user('admission'), b = await f.user('admissionpeer'), first = (await f.service.createGroup(a.token, randomUUID(), 'Admission one')).conversationId, second = (await f.service.createGroup(b.token, randomUUID(), 'Admission two')).conversationId;
  // Fixture-only completion frees prior rows; real publication completion is covered by broker failure tests.
  await f.db.collection<OutboxRecord>('outbox').updateMany({ status: 'pending' }, { $set: { status: 'published', publishedAt: new Date() } });
  const bounded = new MessageService(new AuthService({ ...f.config, MAX_PENDING_OUTBOX: 1 }, f.client, f.db));
  const results = await Promise.allSettled([bounded.send(a.token, command(first)), bounded.send(b.token, command(second))]); expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  expect(await f.db.collection('outbox').countDocuments({ status: 'pending' })).toBe(1);
});
it('upgrades existing 002 pending records additively and does not replace a later messages validator on rerun', async () => {
  const db = f.client.db(`upgrade_test_${randomUUID().replaceAll('-', '')}`);
  try {
    await migrateAuth(db); await migrateConversations(db, async () => {});
    const eventId = randomUUID(), conversationId = randomUUID(), now = new Date();
    const event: ControlEvent = { _id: eventId, schemaVersion: 1, conversationId, sequence: Long.ONE, actorId: randomUUID(), kind: 'conversation.created', payload: {}, createdAt: now };
    const outbox: OutboxRecord = { _id: eventId, schemaVersion: 1, eventId, topic: 'conversation.control.v1', status: 'pending', availableAt: now, leaseUntil: new Date(0), leaseOwner: null, attempts: 0, publishedAt: null, createdAt: now };
    await db.collection<ControlEvent>('conversationEvents').insertOne(event); await db.collection<OutboxRecord>('outbox').insertOne(outbox);
    await runMigrations(db); expect(await db.collection<OutboxRecord>('outbox').findOne({ _id: eventId })).toEqual(outbox); expect(await db.collection<ControlEvent>('conversationEvents').findOne({ _id: eventId })).toEqual(event);
    const metadata = await db.listCollections({ name: 'messages' }).next(); if (!metadata || !('options' in metadata)) throw new Error('Missing messages collection');
    const validator = metadata.options?.validator as { $jsonSchema: { properties: Record<string, unknown> } }; validator.$jsonSchema.properties['futureOptionalField'] = { bsonType: 'string' };
    await db.command({ collMod: 'messages', validator }); await runMigrations(db);
    const after = await db.listCollections({ name: 'messages' }).next(); expect(JSON.stringify(after)).toContain('futureOptionalField');
    expect(await db.collection('outboxAdmission').countDocuments({})).toBe(3);
  } finally { await db.dropDatabase(); }
});
