import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';

const magic = Buffer.from('CRBACK01'), chunkSize = 65536;
export const limits = { bytes: 512 * 1048576, entryBytes: 256 * 1048576, entries: 130, jsonBytes: 65536 };
export interface Entry { name: string; bytes: number; sha256: string }
export interface BundleManifest { v: 1; kind: 'snapshot' | 'policy'; id: string; source: string; capturedAt: string; entries: Entry[]; detail: Record<string, unknown> }
export class RecoveryError extends Error { constructor(message: string) { super(message); this.name = 'RecoveryError'; } }
export function recoveryKey(value = process.env['RECOVERY_KEY']) {
  if (!value || !/^[a-f0-9]{64}$/.test(value)) throw new RecoveryError('RECOVERY_KEY must contain 32 random bytes encoded as lowercase hex');
  return Buffer.from(value, 'hex');
}
function nonce(header: Buffer, sequence: number) { const iv = Buffer.alloc(12); header.copy(iv, 0, 24, 28); iv.writeBigUInt64BE(BigInt(sequence), 4); return iv; }
function associated(header: Buffer, sequence: number) { const seq = Buffer.alloc(8); seq.writeBigUInt64BE(BigInt(sequence)); return Buffer.concat([header, seq]); }
async function write(handle: FileHandle, value: Buffer) { let offset = 0; while (offset < value.length) { const result = await handle.write(value, offset, value.length - offset); if (!result.bytesWritten) throw new RecoveryError('Bundle write failed'); offset += result.bytesWritten; } }
async function read(handle: FileHandle, length: number, eof = false) {
  const value = Buffer.alloc(length); let offset = 0;
  while (offset < length) { const result = await handle.read(value, offset, length - offset); if (!result.bytesRead) { if (!offset && eof) return null; throw new RecoveryError('Bundle is truncated'); } offset += result.bytesRead; }
  return value;
}
export async function createBundle(path: string, key: Buffer, base: Omit<BundleManifest, 'v' | 'id' | 'entries'>, produce: (add: (name: string, bytes: AsyncIterable<Uint8Array>) => Promise<void>) => Promise<void>) {
  const handle = await open(path, 'wx', 0o600), header = Buffer.concat([magic, randomBytes(20)]), entries: Entry[] = []; let sequence = 0, total = 0, committed = false;
  const frame = async (kind: number, bytes: Buffer) => {
    if (bytes.length > chunkSize || ++sequence > 20000) throw new RecoveryError('Bundle frame limit');
    const cipher = createCipheriv('aes-256-gcm', createHmac('sha256', key).update(header).digest(), nonce(header, sequence)); cipher.setAAD(associated(header, sequence));
    const encrypted = Buffer.concat([cipher.update(Buffer.concat([Buffer.from([kind]), bytes])), cipher.final()]), size = Buffer.alloc(4); size.writeUInt32BE(encrypted.length);
    await write(handle, Buffer.concat([size, encrypted, cipher.getAuthTag()]));
  };
  try {
    await write(handle, header);
    await produce(async (name, bytes) => {
      if (!/^[a-zA-Z0-9_-]{1,100}$/.test(name) || entries.some(entry => entry.name === name) || entries.length >= limits.entries) throw new RecoveryError('Invalid bundle entry');
      await frame(1, Buffer.from(JSON.stringify({ name })));
      const hash = createHash('sha256'); let count = 0;
      for await (const raw of bytes) for (let offset = 0; offset < raw.length; offset += chunkSize) {
        const part = Buffer.from(raw.subarray(offset, offset + chunkSize)); count += part.length; total += part.length;
        if (count > limits.entryBytes || total > limits.bytes) throw new RecoveryError('Bundle byte limit');
        hash.update(part); await frame(2, part);
      }
      const entry = { name, bytes: count, sha256: hash.digest('hex') }; entries.push(entry); await frame(3, Buffer.from(JSON.stringify(entry)));
    });
    const manifest: BundleManifest = { ...base, v: 1, id: header.subarray(8, 24).toString('hex'), entries };
    await frame(4, Buffer.from(JSON.stringify(manifest))); await handle.sync(); committed = true; return manifest;
  } finally { await handle.close(); if (!committed) await unlink(path).catch(() => {}); }
}
export interface BundleHandler { begin(entry: string): Promise<void>; data(bytes: Buffer): Promise<void>; end(entry: Entry): Promise<void> }
export async function inspectBundle(path: string, key: Buffer, handler?: BundleHandler): Promise<BundleManifest> {
  const file = await open(path, 'r'); let total = 0, sequence = 0, active: { name: string; bytes: number; hash: ReturnType<typeof createHash> } | undefined;
  const entries: Entry[] = [];
  try {
    if ((await file.stat()).size > limits.bytes + 1048576) throw new RecoveryError('Bundle file limit');
    const header = (await read(file, 28))!; if (!header.subarray(0, 8).equals(magic)) throw new RecoveryError('Unsupported bundle format');
    for (;;) {
      const size = (await read(file, 4))!.readUInt32BE(); if (size < 1 || size > chunkSize + 1 || ++sequence > 20000) throw new RecoveryError('Invalid bundle frame');
      const encrypted = (await read(file, size))!, tag = (await read(file, 16))!, decipher = createDecipheriv('aes-256-gcm', createHmac('sha256', key).update(header).digest(), nonce(header, sequence));
      decipher.setAAD(associated(header, sequence)); decipher.setAuthTag(tag);
      let value: Buffer; try { value = Buffer.concat([decipher.update(encrypted), decipher.final()]); } catch { throw new RecoveryError('Bundle authentication failed'); }
      const type = value[0], bytes = value.subarray(1);
      if (type === 2) {
        if (!active) throw new RecoveryError('Unexpected bundle data'); active.bytes += bytes.length; total += bytes.length;
        if (active.bytes > limits.entryBytes || total > limits.bytes) throw new RecoveryError('Bundle byte limit'); active.hash.update(bytes); await handler?.data(bytes); continue;
      }
      let json: Record<string, unknown>; try { json = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>; } catch { throw new RecoveryError('Invalid bundle metadata'); }
      if (type === 1) {
        if (active || typeof json['name'] !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(json['name']) || entries.some(e => e.name === json['name']) || entries.length >= limits.entries) throw new RecoveryError('Invalid bundle entry');
        active = { name: json['name'], bytes: 0, hash: createHash('sha256') }; await handler?.begin(active.name);
      } else if (type === 3) {
        if (!active || json['name'] !== active.name || json['bytes'] !== active.bytes || json['sha256'] !== active.hash.digest('hex')) throw new RecoveryError('Bundle entry integrity failed');
        const entry = json as unknown as Entry; entries.push(entry); active = undefined; await handler?.end(entry);
      } else if (type === 4) {
        if (active || json['v'] !== 1 || !['snapshot', 'policy'].includes(String(json['kind'])) || json['id'] !== header.subarray(8, 24).toString('hex') || !/^[a-zA-Z][a-zA-Z0-9_]{0,50}$/.test(String(json['source'])) || !Number.isFinite(Date.parse(String(json['capturedAt']))) || !json['detail'] || JSON.stringify(json['entries']) !== JSON.stringify(entries) || await read(file, 1, true) !== null) throw new RecoveryError('Invalid terminal manifest');
        return json as unknown as BundleManifest;
      } else throw new RecoveryError('Unknown bundle frame');
    }
  } finally { await file.close(); }
}
export async function* one(bytes: Buffer) { yield bytes; }
