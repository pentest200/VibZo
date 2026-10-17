import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { AttachmentService, AttachmentWorker, AuthService, SyncService, attachmentMetrics } from '@chat/domain';
import type { AttachmentJob, AttachmentQuota } from '@chat/domain';
import { createApi } from '@chat/api';
import { messagingFixture, command } from './messaging-fixture.js';
const execute = promisify(execFile);
let f: Awaited<ReturnType<typeof messagingFixture>>, files: AttachmentService, worker: AttachmentWorker, sync: SyncService;
const bytes = Buffer.from('A real private file.\n');
beforeAll(async () => { f = await messagingFixture('attachments_test'); files = new AttachmentService(f.auth); worker = new AttachmentWorker(files); sync = new SyncService(f.auth); await files.storage.configureCors(); });
afterAll(async () => {
  if (files) { for (const bucket of [f.config.S3_QUARANTINE_BUCKET, f.config.S3_APPROVED_BUCKET]) { let cursor: string | undefined; do { const page = await files.storage.list(bucket, cursor); for (const object of page.Contents ?? []) if (object.Key) await files.storage.remove(bucket, object.Key); cursor = page.NextContinuationToken; } while (cursor); } files.close(); }
  if (f) await f.close();
});
async function pair(label: string) { const a = await f.user(`${label}a`), b = await f.user(`${label}b`); return { a, b, id: (await sync.createDirect(a.token, b.id)).conversationId }; }
async function reserve(token: string, conversationId: string, data = bytes, kind = 'text', name = 'notes.txt') {
  return files.reserve(token, { commandId: randomUUID(), conversationId, name, kind, size: data.length, sha256: createHash('sha256').update(data).digest('hex') });
}
async function upload(token: string, id: string, data = bytes, kind = 'text', name = 'notes.txt') {
  const ticket = await reserve(token, id, data, kind, name); expect((await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: data })).status).toBe(200);
  const key = randomUUID(); expect(await files.finalize(token, ticket.attachment.id, key)).toEqual(await files.finalize(token, ticket.attachment.id, key)); return ticket;
}
async function processAll() { for (let count = 0; count < 30 && await worker.runOnce(); count++) { /* drain bounded fixture jobs */ } }
it('enforces signed size/type/key/metadata and actual browser CORS, then binds immutable approved bytes', async () => {
  const { a, b, id } = await pair('signed'), ticket = await reserve(a.token, id);
  expect((await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: Buffer.from('wrong length') })).status).toBe(403);
  expect((await fetch(ticket.url, { method: 'PUT', headers: { ...ticket.headers, 'content-type': 'text/html' }, body: bytes })).status).toBe(403);
  expect((await fetch(ticket.url.replace(ticket.attachment.id, randomUUID()), { method: 'PUT', headers: ticket.headers, body: bytes })).status).toBe(403);
  const cors = await fetch(ticket.url, { method: 'OPTIONS', headers: { origin: f.config.WEB_ORIGIN, 'access-control-request-method': 'PUT', 'access-control-request-headers': Object.keys(ticket.headers).join(',') } }); expect(cors.headers.get('access-control-allow-origin')).toBe(f.config.WEB_ORIGIN);
  expect((await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: bytes })).status).toBe(200);
  await files.finalize(a.token, ticket.attachment.id, randomUUID());
  await expect(files.download(a.token, ticket.attachment.id)).rejects.toMatchObject({ status: 403 });
  await processAll(); expect((await files.list(a.token, id)).items[0]!.state).toBe('ready');
  await expect(files.download(b.token, ticket.attachment.id)).rejects.toMatchObject({ status: 403 });
  const send = { ...command(id, ''), attachmentIds: [ticket.attachment.id] }, sent = await sync.send(a.token, send); expect(await sync.send(a.token, send)).toEqual(sent);
  expect((await sync.snapshot(b.token, id)).messages[0]!.attachments).toEqual([{ id: ticket.attachment.id, name: 'notes.txt', kind: 'text', size: bytes.length }]);
  await expect(sync.send(a.token, { ...send, clientMessageId: randomUUID() })).rejects.toMatchObject({ status: 409 });
  expect((await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: Buffer.alloc(bytes.length, 'x') })).status).toBe(200);
  const grant = await files.download(b.token, ticket.attachment.id), response = await fetch(grant.url); expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
  expect(response.headers.get('content-disposition')).toContain('attachment'); expect(response.headers.get('cache-control')).toContain('no-store');
  expect(Number(new URL(grant.url).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(60);
  expect((await fetch(grant.url.split('?')[0]!)).status).toBe(403);
  await sync.setBlock(a.token, b.id, true); await expect(files.download(b.token, ticket.attachment.id)).rejects.toMatchObject({ status: 403 });
  expect((await fetch(grant.url)).status).toBe(200); // Previously issued bearer grant has its documented <=60s window.
});
it('rejects real EICAR, signature spoofing, active text and checksum mismatch without exposing quarantine', async () => {
  const { a, id } = await pair('reject');
  const eicar = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*');
  const tickets = [await upload(a.token, id, eicar), await upload(a.token, id, Buffer.from('<svg onload="alert(1)"></svg>')), await upload(a.token, id, bytes, 'png', 'fake.png'), await upload(a.token, id, Buffer.from('PK0304 archive bytes'), 'text', 'archive.txt')];
  const mismatch = await reserve(a.token, id); await fetch(mismatch.url, { method: 'PUT', headers: mismatch.headers, body: Buffer.alloc(bytes.length, 'x') }); await files.finalize(a.token, mismatch.attachment.id, randomUUID()); tickets.push(mismatch);
  await processAll();
  for (const ticket of tickets) { expect((await files.files().findOne({ _id: ticket.attachment.id }))!.state).toBe('rejected'); await expect(files.download(a.token, ticket.attachment.id)).rejects.toMatchObject({ status: 403 }); }
  expect((await files.files().findOne({ _id: tickets[0]!.attachment.id }))!.error).toMatch(/safety scan/i);
});
// Generate valid small PNGs without introducing a decoder into the API/test host.
function png(width: number, height: number) {
  const chunk = (type: string, data: Buffer) => { const payload = Buffer.concat([Buffer.from(type), data]); let crc = 0xffffffff; for (const byte of payload) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0); } const result = Buffer.alloc(data.length + 12); result.writeUInt32BE(data.length); payload.copy(result, 4); result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4); return result; };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(Buffer.alloc((width * 3 + 1) * height))), chunk('IEND', Buffer.alloc(0))]);
}
it('uses the actual isolated decoder to reencode images and reject a valid oversized pixel image', async () => {
  const { a, id } = await pair('images'), good = await upload(a.token, id, png(16, 16), 'png', 'picture.png'), bomb = await upload(a.token, id, png(9000, 1000), 'png', 'large.png');
  await processAll(); const row = await files.files().findOne({ _id: good.attachment.id }); expect(row).toMatchObject({ state: 'ready', kind: 'webp', name: 'picture.webp', approvedType: 'image/webp' });
  const approved = Buffer.from(await (await fetch((await files.download(a.token, good.attachment.id)).url)).arrayBuffer()); expect(approved.toString('ascii', 8, 12)).toBe('WEBP');
  expect((await files.files().findOne({ _id: bomb.attachment.id }))!.state).toBe('rejected');
});
it('fails closed on actual scanner connection failure and recovers the same durable job after lease loss', async () => {
  const { a, id } = await pair('outage'), ticket = await upload(a.token, id);
  const unavailable = new AttachmentService(new AuthService({ ...f.config, CLAMAV_PORT: 1 }, f.client, f.db));
  try { await new AttachmentWorker(unavailable).runOnce(); } finally { unavailable.close(); await unavailable.auth.close(); }
  expect((await files.files().findOne({ _id: ticket.attachment.id }))!.state).toBe('uploaded'); await expect(files.download(a.token, ticket.attachment.id)).rejects.toMatchObject({ status: 403 });
  await f.db.collection<AttachmentJob>('attachmentJobs').updateOne({ _id: ticket.attachment.id }, { $set: { state: 'claimed', leaseOwner: 'dead-worker', leaseUntil: new Date(0), availableAt: new Date(0) } });
  await processAll(); expect((await files.files().findOne({ _id: ticket.attachment.id }))!.state).toBe('ready');
  expect(await f.db.collection<AttachmentJob>('attachmentJobs').countDocuments({ _id: ticket.attachment.id })).toBe(1);
});
it('serializes account quota reservations and returns the original reservation on a duplicate command', async () => {
  const { a, id } = await pair('quota'), input = { commandId: randomUUID(), conversationId: id, name: 'file.txt', kind: 'text', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  const initial = await files.reserve(a.token, input); expect((await files.reserve(a.token, input)).attachment.id).toBe(initial.attachment.id);
  await expect(files.reserve(a.token, { ...input, name: 'other.txt' })).rejects.toMatchObject({ status: 409 });
  await f.db.collection<AttachmentQuota>('attachmentQuotas').updateOne({ _id: a.id }, { $set: { bytes: f.config.MAX_ACCOUNT_ATTACHMENT_BYTES - bytes.length * 2 } });
  const results = await Promise.allSettled([files.reserve(a.token, { ...input, commandId: randomUUID() }), files.reserve(a.token, { ...input, commandId: randomUUID() })]); expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  await expect(files.reserve(a.token, { ...input, commandId: randomUUID(), size: 26214401 })).rejects.toMatchObject({ status: 400 });
});
it('enforces prejoin/removed history visibility, foreign ownership and transactional delete association', async () => {
  const a = await f.user('visibilitya'), b = await f.user('visibilityb'), id = (await sync.createGroup(a.token, randomUUID(), 'Files visibility')).conversationId;
  const hidden = await upload(a.token, id); await processAll(); await sync.send(a.token, { ...command(id, ''), attachmentIds: [hidden.attachment.id] });
  await sync.invite(a.token, id, b.id); await sync.respondInvitation(b.token, id, true); await expect(files.download(b.token, hidden.attachment.id)).rejects.toMatchObject({ status: 403 });
  const visible = await upload(a.token, id); await processAll();
  await expect(sync.send(b.token, { ...command(id, ''), attachmentIds: [visible.attachment.id] })).rejects.toMatchObject({ status: 409 });
  const sent = await sync.send(a.token, { ...command(id, ''), attachmentIds: [visible.attachment.id] }); await files.download(b.token, visible.attachment.id);
  await sync.remove(a.token, id, b.id); await expect(files.download(b.token, visible.attachment.id)).rejects.toMatchObject({ status: 403 });
  await sync.mutate(a.token, { kind: 'delete', commandId: randomUUID(), conversationId: id, messageId: sent.message.messageId, expectedVersion: '0' });
  await expect(files.download(a.token, visible.attachment.id)).rejects.toMatchObject({ status: 403 }); expect((await sync.snapshot(a.token, id)).messages[0]!.attachments).toEqual([]);
});
it('cleans expired reservations and message derivatives, releasing quota exactly once after upload expiry', async () => {
  const { a, id } = await pair('cleanup'), ticket = await upload(a.token, id); await processAll(); const row = (await files.files().findOne({ _id: ticket.attachment.id }))!;
  await files.removeFile(a.token, row._id, randomUUID()); await worker.maintenanceOnce(); expect((await files.files().findOne({ _id: row._id }))!.state).toBe('deleting');
  await files.files().updateOne({ _id: row._id }, { $set: { uploadExpiresAt: new Date(0) } }); await worker.maintenanceOnce(); await worker.maintenanceOnce();
  expect((await files.files().findOne({ _id: row._id }))!.state).toBe('deleted'); expect((await f.db.collection<AttachmentQuota>('attachmentQuotas').findOne({ _id: a.id }))!.bytes).toBe(0);
  await expect(files.storage.head(row.sourceKey)).rejects.toThrow(); const approved = await files.storage.download(row); expect((await fetch(approved.url)).status).toBe(404);
  const abandoned = await reserve(a.token, id); await files.files().updateOne({ _id: abandoned.attachment.id }, { $set: { uploadExpiresAt: new Date(0) } }); await worker.maintenanceOnce(); expect((await files.files().findOne({ _id: abandoned.attachment.id }))!.state).toBe('deleted');
});
it('protects actual attachment HTTP mutations with exact origin, session, CSRF and strict input', async () => {
  const { a, id } = await pair('http'), api = await createApi(f.config); const headers = { origin: f.config.WEB_ORIGIN, cookie: `commonroom_session=${a.token}`, 'x-csrf-token': a.csrf };
  const payload = { commandId: randomUUID(), conversationId: id, name: 'notes.txt', kind: 'text', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  try {
    expect((await api.app.inject({ method: 'POST', url: '/api/v1/attachments', headers: { ...headers, 'x-csrf-token': 'invalid' }, payload })).statusCode).toBe(403);
    expect((await api.app.inject({ method: 'POST', url: '/api/v1/attachments', headers: { ...headers, origin: 'https://evil.example' }, payload })).statusCode).toBe(403);
    expect((await api.app.inject({ method: 'POST', url: '/api/v1/attachments', headers, payload: { ...payload, ownerId: a.id } })).statusCode).toBe(400);
    expect((await api.app.inject({ method: 'POST', url: '/api/v1/attachments', headers, payload })).statusCode).toBe(200);
  } finally { await api.close(); }
});

it('recovers actual process exit after approved PUT and sweeps the orphan without deleting the winning object', async () => {
  const { a, id } = await pair('crash'), ticket = await upload(a.token, id);
  await expect(execute(process.execPath, ['--import', 'tsx', 'tests/fixtures/attachment-crash.ts'], { env: { ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: f.config.MONGODB_DATABASE }, timeout: 25000 })).rejects.toMatchObject({ code: 73 });
  const jobs = f.db.collection<AttachmentJob>('attachmentJobs'), crashed = (await jobs.findOne({ _id: ticket.attachment.id }))!;
  expect(crashed.state).toBe('claimed'); expect((await files.files().findOne({ _id: ticket.attachment.id }))!.state).toBe('processing');
  await expect(files.download(a.token, ticket.attachment.id)).rejects.toMatchObject({ status: 403 });
  await jobs.updateOne({ _id: crashed._id }, { $set: { leaseUntil: new Date(0), availableAt: new Date(0) } }); await processAll();
  const winner = (await files.files().findOne({ _id: crashed._id }))!; expect(winner.state).toBe('ready'); expect(winner.approvedKey).not.toBe(crashed.candidateKey);
  await new Promise(resolve => setTimeout(resolve, 1200)); await worker.maintenanceOnce(1000);
  expect((await fetch((await files.storage.download({ ...winner, approvedKey: crashed.candidateKey })).url)).status).toBe(404);
  expect(Buffer.from(await (await fetch((await files.download(a.token, winner._id)).url)).arrayBuffer())).toEqual(bytes);
});
it('retains durable state through real storage connection failure and explicitly retries exhausted scans', async () => {
  const { a, id } = await pair('storage'), ticket = await upload(a.token, id), broken = new AttachmentService(new AuthService({ ...f.config, S3_ENDPOINT: 'http://127.0.0.1:1' }, f.client, f.db));
  try { await new AttachmentWorker(broken).runOnce(); } finally { broken.close(); await broken.auth.close(); }
  expect((await files.files().findOne({ _id: ticket.attachment.id }))!.state).toBe('uploaded');
  const jobs = f.db.collection<AttachmentJob>('attachmentJobs'); await jobs.updateOne({ _id: ticket.attachment.id }, { $set: { state: 'failed', attempts: 5 } });
  const retry = randomUUID(); expect(await files.retry(a.token, ticket.attachment.id, retry)).toEqual(await files.retry(a.token, ticket.attachment.id, retry)); await processAll();
  expect((await files.files().findOne({ _id: ticket.attachment.id }))!.state).toBe('ready');
  const pending = await reserve(a.token, id), unavailable = new AttachmentService(new AuthService({ ...f.config, S3_ENDPOINT: 'http://127.0.0.1:1' }, f.client, f.db));
  try { await expect(unavailable.finalize(a.token, pending.attachment.id, randomUUID())).rejects.toMatchObject({ status: 503 }); } finally { unavailable.close(); await unavailable.auth.close(); }
  expect((await files.files().findOne({ _id: pending.attachment.id }))!.state).toBe('pending'); expect(await jobs.countDocuments({ _id: pending.attachment.id })).toBe(0);
});
it('serializes concurrent attachment association against deletion and denies cross-conversation or unknown IDs', async () => {
  const { a, b, id } = await pair('races'), other = (await sync.createGroup(a.token, randomUUID(), 'Other file scope')).conversationId, ticket = await upload(a.token, id); await processAll();
  await expect(sync.send(a.token, { ...command(other, ''), attachmentIds: [ticket.attachment.id] })).rejects.toMatchObject({ status: 409 });
  await expect(files.finalize(b.token, ticket.attachment.id, randomUUID())).rejects.toMatchObject({ status: 403 });
  await expect(files.download(a.token, randomUUID())).rejects.toMatchObject({ status: 403 });
  const raced = await Promise.allSettled([sync.send(a.token, { ...command(id, ''), attachmentIds: [ticket.attachment.id] }), files.removeFile(a.token, ticket.attachment.id, randomUUID())]);
  expect(raced.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const row = (await files.files().findOne({ _id: ticket.attachment.id }))!; expect(row.messageId ? row.state === 'ready' : row.state === 'deleting').toBe(true);
});

it('reports backlog without private keys and fails closed when an approved object is missing', async () => {
  const { a, id } = await pair('missing'), ticket = await upload(a.token, id); await processAll(); const row = (await files.files().findOne({ _id: ticket.attachment.id }))!;
  await files.storage.remove(f.config.S3_APPROVED_BUCKET, row.approvedKey!); await expect(files.download(a.token, row._id)).rejects.toMatchObject({ status: 503 });
  const metrics = await attachmentMetrics(f.db); expect(metrics).toContain('chat_attachment_jobs{state="pending"}'); expect(metrics).not.toContain('http'); expect(metrics).not.toContain(row.sourceKey);
});

it('cleans ready sources, repairs late uploads, expires grants and deletes abandoned ready files without double quota release', async () => {
  const { a, id } = await pair('sourceclean'), ticket = await upload(a.token, id); await processAll(); const row = (await files.files().findOne({ _id: ticket.attachment.id }))!;
  await files.files().updateOne({ _id: row._id }, { $set: { uploadExpiresAt: new Date(0) } }); await worker.maintenanceOnce();
  expect((await f.db.collection<AttachmentQuota>('attachmentQuotas').findOne({ _id: a.id }))!.bytes).toBe(bytes.length); await expect(files.storage.head(row.sourceKey)).rejects.toThrow();
  // Persisted deadlines are advanced in the fixture, without changing machine time. Simulate a late request.
  expect((await fetch(ticket.url, { method: 'PUT', headers: ticket.headers, body: bytes })).status).toBe(200);
  await new Promise(resolve => setTimeout(resolve, 1200)); await worker.maintenanceOnce(1000); await expect(files.storage.head(row.sourceKey)).rejects.toThrow();
  expect((await fetch((await files.download(a.token, row._id)).url)).status).toBe(200);
  const short = new AttachmentService(new AuthService({ ...f.config, DOWNLOAD_URL_SECONDS: 5 }, f.client, f.db));
  try { const grant = await short.download(a.token, row._id); expect((await fetch(grant.url)).status).toBe(200); await new Promise(resolve => setTimeout(resolve, 6100)); const expired = await fetch(grant.url); expect(expired.status).toBe(400); expect(await expired.text()).toContain('Date is too old'); }
  finally { short.close(); await short.auth.close(); }
  await files.files().updateOne({ _id: row._id }, { $set: { expiresAt: new Date(0) } }); await worker.maintenanceOnce(); await worker.maintenanceOnce();
  expect((await files.files().findOne({ _id: row._id }))!.state).toBe('deleted'); expect((await f.db.collection<AttachmentQuota>('attachmentQuotas').findOne({ _id: a.id }))!.bytes).toBe(0);
});

it('processes actual JPEG/WebP inputs and a valid PDF, with approved MIME and safe download suffixes', async () => {
  const { a, id } = await pair('formats');
  for (const format of ['jpeg', 'webp']) {
    const fixture = await execute('docker', ['--config', '.cache/docker', 'compose', '-f', 'infra/compose/compose.yaml', 'exec', '-T', 'image-processor', 'node', '--input-type=module', '-e', `import sharp from 'sharp'; process.stdout.write(await sharp({create:{width:8,height:8,channels:3,background:'#ab1234'}}).${format}().toBuffer());`], { encoding: 'buffer', maxBuffer: 1048576, timeout: 15000 });
    const ticket = await upload(a.token, id, fixture.stdout, format, `picture.${format}`); await processAll(); expect(await files.files().findOne({ _id: ticket.attachment.id })).toMatchObject({ state: 'ready', kind: 'webp', approvedType: 'image/webp' });
  }
  let document = '%PDF-1.4\n'; const offsets = [0], objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 10 10] /Contents 4 0 R >>', '<< /Length 0 >>\nstream\n\nendstream'];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(document)); document += `${index + 1} 0 obj\n${body}\nendobj\n`; }); const xref = Buffer.byteLength(document);
  document += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const pdf = Buffer.from(document), ticket = await upload(a.token, id, pdf, 'pdf', 'safe.html'); await processAll();
  expect(await files.files().findOne({ _id: ticket.attachment.id })).toMatchObject({ state: 'ready', kind: 'pdf', name: 'safe.pdf', approvedType: 'application/pdf' });
  expect(Buffer.from(await (await fetch((await files.download(a.token, ticket.attachment.id)).url)).arrayBuffer())).toEqual(pdf);
});
