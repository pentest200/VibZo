import { randomUUID, createHash } from 'node:crypto';
import { DomainError } from '../auth/errors.js';
import type { AttachmentJob, AttachmentQuota } from './model.js';
import { contentTypes } from './model.js';
import type { AttachmentService } from './service.js';
import { attachmentSchemaReady } from './migrations.js';
import { ownerAuthority, quota } from './store.js';
import { detectFile, scanBytes, transformImage, FileRejected } from './checks.js';
export class AttachmentWorker {
  constructor(readonly service: AttachmentService, private readonly afterApproved?: () => Promise<void>) {}
  async runOnce() {
    const { db, auth, storage } = this.service; if (!await attachmentSchemaReady(db)) return false;
    const jobs = db.collection<AttachmentJob>('attachmentJobs'), owner = randomUUID();
    // Exhausted crashed leases remain inspectable, rather than silently exceeding retry limits.
    await jobs.updateMany({ state: 'claimed', attempts: { $gte: 5 }, $expr: { $lte: ['$leaseUntil', '$$NOW'] } }, { $set: { state: 'failed', leaseOwner: null } });
    const job = await jobs.findOneAndUpdate({ attempts: { $lt: 5 }, $or: [{ state: 'pending', $expr: { $lte: ['$availableAt', '$$NOW'] } }, { state: 'claimed', $expr: { $lte: ['$leaseUntil', '$$NOW'] } }] }, [{ $set: {
      state: 'claimed', leaseOwner: owner, attempts: { $add: ['$attempts', 1] }, leaseUntil: { $dateAdd: { startDate: '$$NOW', unit: 'second', amount: 120 } }, candidateKey: { $concat: [`${storage.prefix()}approved/`, '$_id', `/${owner}`] }
    } }], { sort: { availableAt: 1 }, returnDocument: 'after' }); if (!job) return false;
    let lost = false, committed = false;
    const claim = { _id: job._id, state: 'claimed' as const, leaseOwner: owner, $expr: { $gt: ['$leaseUntil', '$$NOW'] } };
    const heartbeat = setInterval(() => { void jobs.updateOne(claim, [{ $set: { leaseUntil: { $dateAdd: { startDate: '$$NOW', unit: 'second', amount: 120 } } } }]).then(result => { if (!result.matchedCount) lost = true; }).catch(() => { lost = true; }); }, 20000).unref();
    try {
      const row = await this.service.run(async session => {
        const row = await this.service.files().findOne({ _id: job._id }, { session });
        if (!row || !['uploaded', 'processing'].includes(row.state) || row.expiresAt <= new Date()) throw new FileRejected('This file expired or was removed.');
        await ownerAuthority(this.service, row, session); if (!await jobs.findOne(claim, { session })) throw new Error('Scan lease lost');
        await this.service.files().updateOne({ _id: row._id }, { $set: { state: 'processing', error: '' } }, { session }); return row;
      });
      const input = await storage.read(row.sourceKey, row.size);
      if (input.length !== row.size || createHash('sha256').update(input).digest('hex') !== row.sha256) throw new FileRejected('The uploaded bytes do not match this file.');
      const kind = detectFile(input); if (kind !== row.kind || !auth.config.ALLOWED_ATTACHMENT_TYPES.includes(kind)) throw new FileRejected('The file signature does not match its type.');
      await scanBytes(input, auth.config);
      const image = ['jpeg', 'png', 'webp'].includes(kind), output = image ? await transformImage(input, kind, auth.config) : input, type = image ? 'image/webp' : contentTypes[kind];
      if (row.purpose === 'avatar' && (!image || output.length > auth.config.MAX_AVATAR_BYTES)) throw new FileRejected('The processed avatar is too large or is not an image.');
      if (lost) throw new Error('Scan lease lost'); await storage.putApproved(job.candidateKey!, output, type); await this.afterApproved?.();
      await this.service.run(async session => {
        const current = await this.service.files().findOne({ _id: row._id, state: 'processing' }, { session }); if (!current || current.expiresAt <= new Date()) throw new FileRejected('This file expired or was removed.');
        await ownerAuthority(this.service, current, session);
        const done = await jobs.updateOne(claim, { $set: { state: 'done', leaseOwner: null, leaseUntil: new Date(0) } }, { session }); if (!done.matchedCount || lost) throw new Error('Scan lease lost');
        await quota(db, row.ownerId, session); const reservedBytes = row.size + output.length;
        await db.collection<AttachmentQuota>('attachmentQuotas').updateOne({ _id: row.ownerId }, { $inc: { bytes: reservedBytes - current.reservedBytes } }, { session });
        await this.service.files().updateOne({ _id: row._id }, { $set: { state: 'ready', approvedKey: job.candidateKey, approvedSize: output.length, approvedType: type, approvedSha256: createHash('sha256').update(output).digest('hex'), reservedBytes,
          kind: image ? 'webp' : kind, name: `${row.name.replace(/\.[^.]*$/, '').slice(0, 115)}.${image ? 'webp' : kind === 'text' ? 'txt' : kind}` } }, { session });
      }); committed = true;
    } catch (error) {
      const rejected = error instanceof FileRejected, removed = error instanceof DomainError && error.status === 403;
      await this.service.run(async session => {
        const changed = await jobs.updateOne(claim, { $set: { state: rejected || removed ? 'done' : job.attempts >= 5 ? 'failed' : 'pending', leaseOwner: null, leaseUntil: new Date(0), availableAt: new Date(Date.now() + Math.min(30000, 1000 * 2 ** job.attempts)) } }, { session });
        if (changed.matchedCount) await this.service.files().updateOne({ _id: job._id, state: { $in: ['uploaded', 'processing'] } }, { $set: { state: removed ? 'deleting' : rejected ? 'rejected' : 'uploaded', error: rejected ? error.message : removed ? 'File access ended.' : 'File checks are unavailable. Retry later.' } }, { session });
      }).catch(() => { /* durable claim is reclaimed after expiry */ });
    } finally {
      clearInterval(heartbeat);
      if (!committed && job.candidateKey) {
        // Unknown commit results must not delete a successfully committed approved object.
        try { if (!await this.service.files().findOne({ approvedKey: job.candidateKey, state: 'ready' })) await storage.remove(auth.config.S3_APPROVED_BUCKET, job.candidateKey); } catch { /* orphan reconciliation retries */ }
      }
    } return true;
  }
  private cursors = new Map<string, string>();
  async maintenanceOnce(orphanGraceMs = 300000) {
    if (!Number.isInteger(orphanGraceMs) || orphanGraceMs < 1000 || orphanGraceMs > 300000) throw new Error('Invalid orphan grace');
    const { db, storage, auth } = this.service; if (!await attachmentSchemaReady(db)) return;
    const now = new Date(), safeUpload = new Date(Date.now() - 60000), files = this.service.files(), jobs = db.collection<AttachmentJob>('attachmentJobs');
    await files.updateMany({ messageId: null, $or: [{ state: 'pending', uploadExpiresAt: { $lt: safeUpload } }, { state: { $in: ['uploaded', 'processing', 'ready'] }, expiresAt: { $lte: now }, avatarActive: { $ne: true } }] }, { $set: { state: 'deleting', error: 'File expired.' } });
    const rows = await files.find({ $or: [{ state: { $in: ['rejected', 'deleting'] } }, { state: 'ready', sourceCleaned: false, uploadExpiresAt: { $lt: safeUpload } }] }).sort({ createdAt: 1 }).limit(20).toArray();
    for (const row of rows) {
      if (row.uploadExpiresAt >= safeUpload || await jobs.findOne({ _id: row._id, state: 'claimed', $expr: { $gt: ['$leaseUntil', '$$NOW'] } })) continue;
      await storage.remove(auth.config.S3_QUARANTINE_BUCKET, row.sourceKey);
      const deleting = row.state !== 'ready'; if (deleting && row.approvedKey) await storage.remove(auth.config.S3_APPROVED_BUCKET, row.approvedKey);
      await this.service.run(async session => {
        const current = await files.findOne({ _id: row._id, state: row.state }, { session }); if (!current || current.sourceCleaned && !deleting) return;
        await quota(db, current.ownerId, session); const release = deleting ? current.reservedBytes : current.size;
        await db.collection<AttachmentQuota>('attachmentQuotas').updateOne({ _id: current.ownerId }, { $inc: { bytes: -release } }, { session });
        await files.updateOne({ _id: row._id }, { $set: { sourceCleaned: true, reservedBytes: current.reservedBytes - release, ...(deleting ? { state: 'deleted' as const } : {}) } }, { session });
        if (deleting) await jobs.updateOne({ _id: row._id }, { $set: { state: 'done', leaseOwner: null, leaseUntil: new Date(0) } }, { session });
      });
    }
    // Bounded rotating scan repairs objects left after crashes or late requests. Prefix includes this database.
    for (const bucket of [auth.config.S3_QUARANTINE_BUCKET, auth.config.S3_APPROVED_BUCKET]) {
      const page = await storage.list(bucket, this.cursors.get(bucket)); if (page.NextContinuationToken) this.cursors.set(bucket, page.NextContinuationToken); else this.cursors.delete(bucket);
      for (const object of page.Contents ?? []) {
        if (!object.Key || !object.LastModified || object.LastModified.getTime() > Date.now() - orphanGraceMs) continue;
        const key = object.Key;
        if (bucket === auth.config.S3_APPROVED_BUCKET) {
          if (await this.service.run(async session => !!await files.findOne({ approvedKey: key, state: 'ready' }, { session }) || !!await jobs.findOne({ candidateKey: key, state: 'claimed', $expr: { $gt: ['$leaseUntil', '$$NOW'] } }, { session }))) continue;
        } else {
          const row = await files.findOne({ sourceKey: object.Key }); if (row && (row.uploadExpiresAt >= safeUpload || ['uploaded', 'processing'].includes(row.state) && row.expiresAt > now)) continue;
        } await storage.remove(bucket, object.Key);
      }
    }
    // Failed final attempts after a process crash still become user-visible and explicitly retryable.
    const failed = await jobs.find({ state: 'failed' }).limit(20).toArray();
    if (failed.length) await files.updateMany({ _id: { $in: failed.map(row => row._id) }, state: 'processing' }, { $set: { state: 'uploaded', error: 'File checks are unavailable. Retry later.' } });
  }
}
