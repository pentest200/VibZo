import { createHash } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { Config } from '@chat/config';
import { createMongoClient, recoveryReady } from '@chat/domain';
import type { AttachmentRecord } from '@chat/domain';
import { createBundle, inspectBundle, RecoveryError } from './bundle.js';
import { assertLocal, authorityId, catalog, json, mongoContainer, privatePath, quiescent, tool, supportedMarkers } from './runtime.js';

export const policyCollections = ['users', 'memberships', 'visibilityIntervals', 'conversations', 'inboxCounters', 'blocks', 'pairGuards', 'messages', 'attachments'] as const;
export function storage(config: Config) { return new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', requestHandler: { connectionTimeout: 3000, requestTimeout: 30000 } }); }
export async function captureSnapshot(config: Config, output: string, key: Buffer, afterDump?: () => Promise<void>) {
  assertLocal(config); output = await privatePath(output);
  const client = createMongoClient(config), s3 = storage(config); let owned = false;
  try {
    await client.connect(); const db = client.db(config.MONGODB_DATABASE), container = await mongoContainer(client);
    if (!await recoveryReady(db)) throw new RecoveryError('Source restore is incomplete');
    return await quiescent(client, db.databaseName, async () => {
      const markers = await db.collection<{ _id: string; appliedAt: Date }>('schemaMigrations').find().sort({ _id: 1 }).toArray();
      if (!supportedMarkers(markers)) throw new RecoveryError('Source requires exact schema 001-008, 001-009 or 001-010');
      const meta = await catalog(db), attachments = await db.collection<AttachmentRecord>('attachments').find({ state: 'ready' }).limit(129).toArray();
      if (attachments.length > 128) throw new RecoveryError('Approved object budget exceeded');
      const objects: { id: string; entry: string; bytes: number; sha256: string; type: string; key: string }[] = [];
      const base = { kind: 'snapshot' as const, source: db.databaseName, capturedAt: new Date().toISOString(), detail: { authority: await authorityId(client), catalog: meta, markers: json(markers), objects } };
      const manifest = await createBundle(output, key, base, async add => {
        owned = true; const dump = tool(container, 'mongodump', [`--db=${db.databaseName}`, '--archive', '--gzip', '--quiet']);
        dump.child.stdin.end();
        try { await add('database', dump.child.stdout); await dump.finish(); } catch (error) { await dump.stop(); throw error; }
        for (const row of attachments) {
          if (!row.approvedKey?.startsWith(db.databaseName + '/') || !row.approvedSha256 || !/^[a-f0-9]{64}$/.test(row.approvedSha256) || row.approvedSize > config.MAX_ATTACHMENT_BYTES || !row.approvedType) throw new RecoveryError('Approved object metadata invalid');
          const entry = `object_${objects.length}`, result = await s3.send(new GetObjectCommand({ Bucket: config.S3_APPROVED_BUCKET, Key: row.approvedKey }), { abortSignal: AbortSignal.timeout(30000) });
          if (!result.Body || result.ContentLength !== row.approvedSize) throw new RecoveryError('Approved object missing or incomplete');
          const hash = createHash('sha256'); let count = 0;
          async function* bytes() { try { for await (const chunk of result.Body as AsyncIterable<Uint8Array>) { count += chunk.length; if (count > row.approvedSize) throw new RecoveryError('Object size mismatch'); hash.update(chunk); yield chunk; } } finally { (result.Body as { destroy(): void }).destroy(); } }
          await add(entry, bytes()); if (count !== row.approvedSize || hash.digest('hex') !== row.approvedSha256) throw new RecoveryError('Approved object checksum mismatch');
          objects.push({ id: row._id, entry, bytes: count, sha256: row.approvedSha256, type: row.approvedType, key: row.approvedKey });
        }
        await afterDump?.(); base.capturedAt = new Date().toISOString();
      });
      return manifest;
    });
  } catch (error) { if (owned) await unlink(output).catch(() => {}); throw error; }
  finally { s3.destroy(); await client.close(); }
}
export async function capturePolicy(config: Config, snapshot: string, output: string, key: Buffer) {
  assertLocal(config); snapshot = await privatePath(snapshot); output = await privatePath(output);
  const original = await inspectBundle(snapshot, key); if (original.kind !== 'snapshot' || original.source !== config.MONGODB_DATABASE) throw new RecoveryError('Policy source does not match snapshot');
  const client = createMongoClient(config); let owned = false;
  try {
    await client.connect(); const db = client.db(config.MONGODB_DATABASE); await mongoContainer(client);
    if (await authorityId(client) !== original.detail['authority']) throw new RecoveryError('Policy source authority differs from snapshot');
    return await quiescent(client, db.databaseName, async () => {
      const base = { kind: 'policy' as const, source: db.databaseName, capturedAt: new Date().toISOString(), detail: { snapshotId: original.id } };
      return createBundle(output, key, base, async add => {
        owned = true; let total = 0;
        for (const name of policyCollections) {
          const filter = name === 'messages' ? { $or: [{ deletedAt: { $ne: null } }, { 'hiddenFor.0': { $exists: true } }, { pinned: { $exists: true } }] } : {};
          async function* records() {
            yield Buffer.from('['); let count = 0;
            for await (const row of db.collection(name).find(filter).limit(5001).batchSize(1)) {
              if (++count > 5000) throw new RecoveryError('Current policy row budget exceeded');
              const bytes = Buffer.from((count > 1 ? ',' : '') + json(row)); total += bytes.length;
              if (bytes.length > 1048576 || total > 63 * 1048576) throw new RecoveryError('Current policy byte budget exceeded'); yield bytes;
            }
            yield Buffer.from(']');
          }
          await add(name, records());
        }
        base.capturedAt = new Date().toISOString();
      });
    });
  } catch (error) { if (owned) await unlink(output).catch(() => {}); throw error; }
  finally { await client.close(); }
}
