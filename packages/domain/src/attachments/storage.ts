import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Config } from '@chat/config';
import type { AttachmentRecord } from './model.js';
import { contentTypes } from './model.js';
export class AttachmentStorage {
  readonly client: S3Client;
  constructor(readonly config: Config) { this.client = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true, maxAttempts: 1,
    credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY }, requestChecksumCalculation: 'WHEN_REQUIRED', responseChecksumValidation: 'WHEN_REQUIRED', requestHandler: { connectionTimeout: config.DEPENDENCY_TIMEOUT_MS, requestTimeout: 30000 } }); }
  prefix() { return `${this.config.MONGODB_DATABASE}/`; }
  async configureCors() { await this.client.send(new PutBucketCorsCommand({ Bucket: this.config.S3_QUARANTINE_BUCKET, CORSConfiguration: { CORSRules: [{ AllowedOrigins: [this.config.WEB_ORIGIN], AllowedMethods: ['PUT'], AllowedHeaders: ['content-type', 'x-amz-meta-attachment', 'x-amz-meta-owner'], MaxAgeSeconds: 300 }] } })); }
  async upload(row: AttachmentRecord) {
    const headers = { 'content-type': contentTypes[row.kind], 'x-amz-meta-attachment': row._id, 'x-amz-meta-owner': row.ownerId };
    const url = await getSignedUrl(this.client, new PutObjectCommand({ Bucket: this.config.S3_QUARANTINE_BUCKET, Key: row.sourceKey, ContentLength: row.size, ContentType: headers['content-type'], Metadata: { attachment: row._id, owner: row.ownerId } }), {
      expiresIn: Math.max(1, Math.min(this.config.UPLOAD_URL_SECONDS, Math.floor((row.uploadExpiresAt.getTime() - Date.now()) / 1000))),
      signableHeaders: new Set(['content-length', 'content-type']), unhoistableHeaders: new Set(['x-amz-meta-attachment', 'x-amz-meta-owner']) });
    return { url, headers, expiresAt: row.uploadExpiresAt.toISOString() };
  }
  head(key: string) { return this.client.send(new HeadObjectCommand({ Bucket: this.config.S3_QUARANTINE_BUCKET, Key: key })); }
  headApproved(key: string) { return this.client.send(new HeadObjectCommand({ Bucket: this.config.S3_APPROVED_BUCKET, Key: key })); }
  async read(key: string, max: number) {
    const object = await this.client.send(new GetObjectCommand({ Bucket: this.config.S3_QUARANTINE_BUCKET, Key: key }));
    if (!object.Body) throw new Error('Missing object body'); const pieces: Buffer[] = []; let size = 0;
    try { for await (const piece of object.Body as AsyncIterable<Uint8Array>) { size += piece.length; if (size > max) throw new Error('Object size limit'); pieces.push(Buffer.from(piece)); } }
    finally { if ('destroy' in object.Body && typeof object.Body.destroy === 'function') object.Body.destroy(); }
    return Buffer.concat(pieces);
  }
  putApproved(key: string, bytes: Buffer, type: string) { return this.client.send(new PutObjectCommand({ Bucket: this.config.S3_APPROVED_BUCKET, Key: key, Body: bytes, ContentLength: bytes.length, ContentType: type, CacheControl: 'private, no-store', ContentDisposition: 'attachment' })); }
  remove(bucket: string, key: string) { if (!key.startsWith(this.prefix())) throw new Error('Foreign object prefix'); return this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })); }
  list(bucket: string, after?: string) { return this.client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: this.prefix(), MaxKeys: 50, ...(after ? { ContinuationToken: after } : {}) })); }
  async download(row: AttachmentRecord, inline = false) {
    if (!row.approvedKey || !row.approvedType) throw new Error('Missing approved object');
    const name = row.name.replace(/[^a-zA-Z0-9._ -]/g, '_'), encoded = encodeURIComponent(row.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    const disposition = inline && /^(?:image\/(?:jpeg|png|webp|gif)|video\/(?:mp4|webm)|audio\/(?:mpeg|wav|ogg))$/.test(row.approvedType) ? 'inline' : 'attachment';
    return { url: await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.S3_APPROVED_BUCKET, Key: row.approvedKey, ResponseContentType: row.approvedType, ResponseContentDisposition: `${disposition}; filename="${name}"; filename*=UTF-8''${encoded}`, ResponseCacheControl: 'private, no-store' }), { expiresIn: this.config.DOWNLOAD_URL_SECONDS }), expiresAt: new Date(Date.now() + this.config.DOWNLOAD_URL_SECONDS * 1000).toISOString() };
  }
  async avatarDownload(row: AttachmentRecord) {
    if (!row.approvedKey || row.purpose !== 'avatar' || row.approvedType !== 'image/webp') throw new Error('Missing approved avatar');
    const seconds = Math.min(30, this.config.DOWNLOAD_URL_SECONDS);
    return { url: await getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.config.S3_APPROVED_BUCKET, Key: row.approvedKey, ResponseContentType: 'image/webp', ResponseContentDisposition: 'inline', ResponseCacheControl: 'private, no-store' }), { expiresIn: seconds }), expiresAt: new Date(Date.now() + seconds * 1000).toISOString() };
  }
  close() { this.client.destroy(); }
}
