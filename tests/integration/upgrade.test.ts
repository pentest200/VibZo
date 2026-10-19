import { beforeAll, afterAll, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, realpath, writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '@chat/config';
import { createMongoClient, BrokerTransport, LiveKitProvider } from '@chat/domain';
import type { OutboxRecord, CallRecord } from '@chat/domain';
import type { AcceptedMessage } from '@chat/contracts';
import { prepareUpgradeArtifact } from '../../scripts/prepare-upgrade.js';
import { upgradeProcess } from './upgrade-fixture.js';
import { command, waitFor } from './messaging-fixture.js';

type Process = Awaited<ReturnType<typeof upgradeProcess>>;
interface User { id: string; token: string; csrf: string }
const database = `upgrade_test_${randomUUID().replaceAll('-', '')}`, config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: database, CALLS_ENABLED: 'true' });
const client = createMongoClient(config), db = client.db(database), processes: Process[] = [];
let prior: Process, current: Process, actor: User, peer: User, outsider: User, group: string;
let artifact: Awaited<ReturnType<typeof prepareUpgradeArtifact>>, initialMarkers: number;
let fixtureOwned = false;
const evidence: Record<string, unknown> = {}, migrations = ['auth', 'conversations', 'messaging', 'sync', 'attachments', 'safety', 'calls', 'operations'];
const directory = `.cache/upgrade-drill-${randomUUID()}`;
const fingerprint = async () => createHash('sha256').update(JSON.stringify(await db.collection('schemaMigrations').find().sort({ _id: 1 }).toArray())).digest('hex');
async function start(path: string) { const child = await upgradeProcess(path, database, { CALLS_ENABLED: 'true' }); processes.push(child); return child; }
async function settled() { await waitFor(async () => await db.collection('consumerEffects').countDocuments() === 2 * await db.collection('conversationEvents').countDocuments(), 20000); }
async function naturalExpiry(deadline: unknown) { const remaining = Date.parse(String(deadline)) - Date.now() + 100; if (remaining > 31000) throw new Error('Unexpected lease budget'); if (remaining > 0) await delay(remaining); }
async function httpSend(url: string, input: ReturnType<typeof command>) {
  const response = await fetch(url + '/api/v1/messages', { method: 'POST', signal: AbortSignal.timeout(10000), headers: { Origin: config.WEB_ORIGIN, Cookie: `commonroom_session=${actor.token}`, 'X-CSRF-Token': actor.csrf, 'Content-Type': 'application/json', Connection: 'close' }, body: JSON.stringify(input) });
  if (!response.ok) throw { status: response.status }; return response.json() as Promise<AcceptedMessage>;
}
beforeAll(async () => {
  await mkdir(directory); artifact = await prepareUpgradeArtifact(); await client.connect();
  if (await db.listCollections().hasNext()) throw new Error('Occupied upgrade fixture');
  fixtureOwned = true;
  prior = await start(artifact.directory); initialMarkers = await prior.request<number>('migrate');
  actor = await prior.request<User>('user'); peer = await prior.request<User>('user'); outsider = await prior.request<User>('user');
  group = (await prior.request<{ conversationId: string }>('group', { token: actor.token, commandId: randomUUID() })).conversationId;
  evidence['sourceMigrations'] = await Promise.all(migrations.map(async name => ({ name, sha256: createHash('sha256').update(await readFile(`packages/domain/src/${name}/migrations.ts`)).digest('hex') })));
});
afterAll(async () => {
  for (const child of processes.reverse()) await child.close();
  if (fixtureOwned) {
    const users = await db.collection<{ _id: string }>('users').find().toArray();
    if (users.some(user => ![actor, peer, outsider].some(known => known?.id === user._id))) throw new Error('Foreign user in upgrade fixture');
    const provider = new LiveKitProvider(config);
    for (const room of await db.collection<{ _id: string }>('callRooms').find().toArray()) { if (!room._id.startsWith(database + '_')) throw new Error('Foreign media fixture'); await provider.removeRoom(room._id); }
    const broker = await BrokerTransport.open(config); try { await broker.deleteTestTopology(); } finally { await broker.close(); }
    await db.dropDatabase();
  }
  await client.close();
  if (evidence['sourceMigrations']) expect(await Promise.all(migrations.map(async name => ({ name, sha256: createHash('sha256').update(await readFile(`packages/domain/src/${name}/migrations.ts`)).digest('hex') })))).toEqual(evidence['sourceMigrations']);
  await writeFile(directory + '/evidence.json', JSON.stringify(evidence));
});
it('loads the actual prior compiled artifact and refuses production or restore-target drivers', async () => {
  expect(initialMarkers).toBe(7); expect(prior.identity.commit).toBe(artifact.commit); expect(prior.identity.domainSha256).toBe(artifact.domainSha256);
  expect(prior.identity.modulePath).toBe(await realpath(resolve(artifact.directory, 'packages/domain/dist/index.js')));
  for (const name of ['chat', `restore_${randomUUID().replaceAll('-', '')}`]) await expect(upgradeProcess('.', name)).rejects.toThrow('refuses');
  evidence['prior'] = prior.identity;
});
it('overlaps old/new v1 writers through additive migration, retries and rollback without changing markers', async () => {
  const oldInput = command(group, 'Prior artifact message'), oldAccepted = await prior.request<AcceptedMessage>('send', { token: actor.token, command: oldInput });
  current = await start('.'); expect(current.identity.modulePath).not.toBe(prior.identity.modulePath); evidence['current'] = current.identity;
  expect(await current.request('migrate')).toBe(8); const markers = await fingerprint();
  const oldHttp = await prior.request<{ url: string; modulePath: string; sha256: string }>('http-start'), newHttp = await current.request<{ url: string; modulePath: string; sha256: string }>('http-start');
  expect(oldHttp.modulePath).toBe(await realpath(resolve(artifact.directory, 'apps/api/dist/app.js'))); expect(oldHttp.sha256).toBe(artifact.apiSha256); expect(oldHttp.modulePath).not.toBe(newHttp.modulePath);
  evidence['priorHttp'] = oldHttp; evidence['currentHttp'] = newHttp;
  expect(await prior.request('migrate')).toBe(8); expect(await current.request('migrate')).toBe(8); expect(await fingerprint()).toBe(markers);
  expect(await current.request('send', { token: actor.token, command: oldInput })).toEqual(oldAccepted);
  const input = command(group, 'Concurrent cross-version command');
  const [oldResult, newResult] = await Promise.all([httpSend(oldHttp.url, input), httpSend(newHttp.url, input)]);
  expect(oldResult).toEqual(newResult); expect(await db.collection('messages').countDocuments({ clientMessageId: input.clientMessageId })).toBe(1);
  for (const endpoint of [oldHttp.url, newHttp.url]) await expect(httpSend(endpoint, { ...input, text: 'Conflicting HTTP retry' })).rejects.toMatchObject({ status: 409 });
  for (const child of [prior, current]) {
    await expect(child.request('send', { token: actor.token, command: { ...input, text: 'Conflicting retry' } })).rejects.toMatchObject({ status: 409 });
    await expect(child.request('send', { token: actor.token, command: { ...command(group), unsupported: true } })).rejects.toMatchObject({ status: 400 });
    await expect(child.request('snapshot', { token: outsider.token, conversationId: group })).rejects.toMatchObject({ status: 403 });
  }
  await current.request('invite', { token: actor.token, conversationId: group, userId: peer.id }); await prior.request('accept', { token: peer.token, conversationId: group });
  await current.request('remove', { token: actor.token, conversationId: group, userId: peer.id });
  await expect(prior.request('send', { token: peer.token, command: command(group) })).rejects.toMatchObject({ status: 403 });
  await prior.request('drain'); await current.request('drain');
  const fresh = command(group, 'Current artifact message'); const accepted = await httpSend(newHttp.url, fresh);
  const tracedRow = await db.collection<OutboxRecord>('outbox').findOne({ _id: accepted.eventId }); expect(tracedRow?.traceparent).toMatch(/^00-[a-f0-9]{32}-[a-f0-9]{16}-01$/);
  const oldRelay = await prior.hold('hold-confirm'); expect(oldRelay.data['eventId']).toBe(accepted.eventId); prior.release(); await oldRelay.completed;
  expect((await db.collection<OutboxRecord>('outbox').findOne({ _id: accepted.eventId }))?.traceparent).toBe(tracedRow!.traceparent);
  expect(await prior.request('send', { token: actor.token, command: fresh })).toEqual(accepted);
  // This is an old-writer rollback on additive schema 008, without dropping fields/markers.
  await prior.request('send', { token: actor.token, command: command(group, 'Rollback writer still accepted') });
  expect(await fingerprint()).toBe(markers);
});
it('runs old/current Rabbit consumers together and applies each v1 effect/job once', async () => {
  await prior.request('consume'); await current.request('consume');
  for (let index = 0; index < 20; index++) await (index % 2 ? prior : current).request('send', { token: actor.token, command: command(group, `Overlap ${index}`) });
  await Promise.all([prior.request('drain'), current.request('drain')]); await settled();
  expect((await prior.request<{ effects: number }>('stats')).effects).toBeGreaterThan(0); expect((await current.request<{ effects: number }>('stats')).effects).toBeGreaterThan(0);
  expect(await db.collection('fanoutJobs').countDocuments()).toBe(await db.collection('conversationEvents').countDocuments());
  expect(await db.collection('notificationJobs').countDocuments()).toBe(await db.collection('messages').countDocuments());
  expect(await db.collection('outbox').countDocuments({ status: { $ne: 'published' } })).toBe(0);
});
it('fences a live stale owner after actual lease expiry and prior-version takeover', async () => {
  await current.request('send', { token: actor.token, command: command(group, 'Natural lease expiry') });
  const stale = await current.hold('hold-claim'); expect(await prior.request('drain')).toBe(0);
  const start = performance.now(); await naturalExpiry(stale.data['leaseUntil']); const replacement = await prior.hold('hold-confirm');
  current.release(); await expect(stale.completed).rejects.toMatchObject({ code: 'LEASE_LOST' });
  prior.release(); await replacement.completed; await settled(); evidence['naturalLeaseWaitMs'] = performance.now() - start;
});
it('kills a confirmed prior publisher and recovers publication after the real lease deadline', async () => {
  const sent = await current.request<AcceptedMessage>('send', { token: actor.token, command: command(group, 'Killed publisher') });
  const owner = await start(artifact.directory), held = await owner.hold('hold-confirm'); expect(held.data['eventId']).toBe(sent.eventId);
  await owner.terminate(); const row = await db.collection<OutboxRecord>('outbox').findOne({ _id: sent.eventId }); expect(row?.status).toBe('claimed');
  expect(await current.request('drain')).toBe(0); await naturalExpiry(held.data['leaseUntil']); await current.request('drain'); await settled();
  expect((await db.collection<OutboxRecord>('outbox').findOne({ _id: sent.eventId }))?.attempts).toBe(2);
  expect(await db.collection('consumerEffects').countDocuments({ eventId: sent.eventId })).toBe(2);
  expect(await db.collection('fanoutJobs').countDocuments({ eventId: sent.eventId })).toBe(1);
});
it('kills a consumer after its effect commits before ACK and deduplicates actual redelivery', async () => {
  await settled(); await prior.request('stop-consumers'); await current.request('stop-consumers');
  const sent = await current.request<AcceptedMessage>('send', { token: actor.token, command: command(group, 'Committed before ACK') }); await current.request('drain');
  const owner = await start(artifact.directory), held = await owner.hold('hold-effect'); expect(held.data['eventId']).toBe(sent.eventId); await owner.terminate();
  const baseline = (await current.request<{ duplicates: number }>('stats')).duplicates; await current.request('consume');
  await waitFor(async () => (await current.request<{ duplicates: number }>('stats')).duplicates > baseline, 20000); await settled();
  expect(await db.collection('fanoutJobs').countDocuments({ eventId: sent.eventId })).toBe(1);
});
it('kills a media allocator after real room creation and recovers its expired claim without an orphan', async () => {
  const call = await current.request<{ id: string }>('call-start', { token: actor.token, command: { commandId: randomUUID(), conversationId: group, mode: 'voice' } });
  const owner = await start('.'); await owner.hold('hold-call');
  const row = await db.collection<CallRecord>('calls').findOne({ _id: call.id }); expect(row?.leaseOwner).toBeTruthy();
  const provider = new LiveKitProvider(config); expect(await provider.participants(row!.roomName)).not.toBeNull();
  await owner.terminate(); expect((await db.collection('callRooms').findOne({ _id: row!.roomName as never }))?.['state']).toBe('pending');
  await naturalExpiry(row!.leaseUntil.toISOString()); await current.request('call-worker');
  expect((await db.collection('callRooms').findOne({ _id: row!.roomName as never }))?.['state']).toBe('ready');
  expect((await provider.client.listRooms()).filter(room => room.name.startsWith(database + '_')).map(room => room.name)).toEqual([row!.roomName]);
});
