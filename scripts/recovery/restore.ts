import { randomUUID, createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import type { Config } from '@chat/config';
import { createMongoClient } from '@chat/domain';
import type { AttachmentRecord } from '@chat/domain';
import { inspectBundle, RecoveryError } from './bundle.js';
import { assertLocal, canonical, catalog, mongoContainer, parse, privatePath, tool, supportedMarkers } from './runtime.js';
import type { Catalog } from './runtime.js';
import { storage } from './capture.js';
import { loadPolicy, sanitize } from './policy.js';

interface ObjectEntry { id: string; entry: string; bytes: number; sha256: string; type: string; key: string }
export async function restoreSnapshot(config: Config, snapshotPath: string, policyPath: string, key: Buffer, target = `restore_${randomUUID().replaceAll('-', '')}`, inspectStage?: (stage: 'claimed' | 'loaded') => Promise<void>) {
  assertLocal(config);
  if (!/^restore_[a-f0-9]{32}$/.test(target) || target === config.MONGODB_DATABASE) throw new RecoveryError('Restore target must be a fresh restore_<32 hex> namespace');
  snapshotPath = await privatePath(snapshotPath); policyPath = await privatePath(policyPath);
  const manifest = await inspectBundle(snapshotPath, key), current = await loadPolicy(policyPath, key), policyTime = Date.parse(current.manifest.capturedAt), now = Date.now();
  if (manifest.kind !== 'snapshot' || current.manifest.source !== manifest.source || current.manifest.detail['snapshotId'] !== manifest.id || policyTime < Date.parse(manifest.capturedAt) || policyTime > now + 5000 || now - policyTime > 3600000) throw new RecoveryError('A matching current policy captured after this snapshot within one hour is required');
  if (manifest.source === target) throw new RecoveryError('Source cannot be a restore target');
  const meta = manifest.detail['catalog'] as Catalog[], objects = manifest.detail['objects'] as ObjectEntry[];
  if (!Array.isArray(meta) || !Array.isArray(objects) || objects.length > 128 || manifest.entries[0]?.name !== 'database' || manifest.entries.length !== objects.length + 1 || objects.some((object, i) => !object || object.entry !== manifest.entries[i + 1]?.name || object.bytes !== manifest.entries[i + 1]?.bytes || object.sha256 !== manifest.entries[i + 1]?.sha256 || !object.key.startsWith(manifest.source + '/') || object.bytes > config.MAX_ATTACHMENT_BYTES)) throw new RecoveryError('Snapshot inventory is inconsistent');
  const markers = parse<{ _id: string; appliedAt: Date }[]>(String(manifest.detail['markers']));
  if (!supportedMarkers(markers)) throw new RecoveryError('Snapshot schema is unsupported');
  const client = createMongoClient(config), s3 = storage(config), owner = randomUUID(); let claimed = false, dump: ReturnType<typeof tool> | undefined, stream: PassThrough | undefined, upload: Promise<unknown> | undefined, uploadError: unknown;
  const db = client.db(target);
  try {
    await client.connect(); const container = await mongoContainer(client);
    if (await db.listCollections().hasNext()) throw new RecoveryError('Restore target already exists');
    await db.createCollection('restoreControl'); claimed = true;
    await db.collection<{ _id: string; owner: string; state: string; snapshotId: string; policyId: string; createdAt: Date }>('restoreControl').insertOne({ _id: 'state', owner, state: 'restoring', snapshotId: manifest.id, policyId: current.manifest.id, createdAt: new Date() });
    if ((await db.listCollections().toArray()).length !== 1) throw new RecoveryError('Restore target changed during claim');
    await inspectStage?.('claimed');
    let entry = '', object: ObjectEntry | undefined, approved: AttachmentRecord | null = null, destination = '';
    const replay = await inspectBundle(snapshotPath, key, {
      async begin(name) {
        entry = name; object = undefined; approved = null; stream = undefined; upload = undefined; uploadError = undefined;
        if (name === 'database') {
          dump = tool(container, 'mongorestore', ['--archive', '--gzip', '--quiet', '--stopOnError', '--numParallelCollections=1', `--nsInclude=${manifest.source}.*`, `--nsFrom=${manifest.source}.*`, `--nsTo=${target}.*`, ...['schemaMigrations', 'migrationLocks', 'restoreControl'].map(name => `--nsExclude=${manifest.source}.${name}`)]); dump.child.stdout.resume(); return;
        }
        object = objects.find(value => value.entry === name); if (!object) throw new RecoveryError('Unexpected snapshot object');
        approved = await db.collection<AttachmentRecord>('attachments').findOne({ _id: object.id, state: 'ready' });
        if (!approved) return; // Policy-retired bytes are verified but never copied into a serving prefix.
        destination = `${target}/approved/${object.id}/${randomUUID()}`;
        stream = new PassThrough({ highWaterMark: 65536 }); stream.on('error', () => {});
        upload = s3.send(new PutObjectCommand({ Bucket: config.S3_APPROVED_BUCKET, Key: destination, Body: stream, ContentLength: object.bytes, ContentType: object.type, CacheControl: 'private, no-store', ContentDisposition: 'attachment' }), { abortSignal: AbortSignal.timeout(30000) }).catch(error => { uploadError = error; stream?.destroy(); });
      },
      async data(bytes) {
        if (entry === 'database') { if (!dump) throw new RecoveryError('Database stream missing'); await new Promise<void>((done, reject) => dump!.child.stdin.write(bytes, error => error ? reject(new RecoveryError('Restore input failed')) : done())); }
        else if (stream) { if (uploadError) throw new RecoveryError('Approved object copy failed'); await new Promise<void>((done, reject) => stream!.write(bytes, error => error ? reject(new RecoveryError('Object stream failed')) : done())); }
      },
      async end() {
        if (entry === 'database') {
          dump!.child.stdin.end(); await dump!.finish(); dump = undefined;
          const actual = await catalog(db);
          if (canonical(actual) !== canonical(meta)) { const names = [...new Set([...actual, ...meta].map(row => row.name))].filter(name => canonical(actual.find(row => row.name === name) ?? null) !== canonical(meta.find(row => row.name === name) ?? null)); throw new RecoveryError(`Restored metadata, indexes or row counts differ: ${names.join(', ')}`); }
          await inspectStage?.('loaded');
          await sanitize(client, db, { ...config, MONGODB_DATABASE: target }, current.policy); return;
        }
        if (!stream || !approved || !object) return;
        stream.end(); await upload; if (uploadError) throw new RecoveryError('Approved object copy failed');
        const verify = await s3.send(new GetObjectCommand({ Bucket: config.S3_APPROVED_BUCKET, Key: destination }), { abortSignal: AbortSignal.timeout(30000) });
        if (!verify.Body || verify.ContentLength !== object.bytes) throw new RecoveryError('Restored object length differs');
        const hash = createHash('sha256'); let bytes = 0;
        try { for await (const piece of verify.Body as AsyncIterable<Uint8Array>) { bytes += piece.length; if (bytes > object.bytes) throw new RecoveryError('Restored object overrun'); hash.update(piece); } } finally { (verify.Body as { destroy(): void }).destroy(); }
        if (bytes !== object.bytes || hash.digest('hex') !== object.sha256) throw new RecoveryError('Restored object checksum differs');
        await db.collection<AttachmentRecord>('attachments').updateOne({ _id: approved._id }, { $set: { approvedKey: destination, sourceKey: `${target}/retired/${approved._id}`, sourceCleaned: true } });
      }
    });
    if (canonical(replay) !== canonical(manifest)) throw new RecoveryError('Snapshot changed during restore');
    for await (const row of db.collection<AttachmentRecord>('attachments').find({ state: 'ready' })) if (!row.approvedKey?.startsWith(target + '/approved/')) throw new RecoveryError('Unverified object reference remains');
    // No schema marker was visible to even a prior worker before every recovery check completed.
    await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').insertMany(markers);
    const updated = await db.collection<{ _id: string; owner: string; state: string }>('restoreControl').updateOne({ _id: 'state', owner, state: 'restoring' }, { $set: { state: 'ready' } });
    if (updated.modifiedCount !== 1) throw new RecoveryError('Restore ownership lost');
    return { target, owner, snapshotId: manifest.id, policyId: current.manifest.id };
  } catch (error) {
    stream?.destroy(); await upload; await dump?.stop();
    if (claimed) await db.collection<{ _id: string; owner: string; state: string }>('restoreControl').updateOne({ _id: 'state', owner }, { $set: { state: 'failed' } }).catch(() => {});
    throw error;
  } finally { s3.destroy(); await client.close(); }
}
