import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createBundle, inspectBundle, one, recoveryKey, limits } from '../../scripts/recovery/bundle.js';
import { privatePath } from '../../scripts/recovery/runtime.js';
const directory = `.cache/recovery-format-${randomUUID()}`, files: string[] = [], key = randomBytes(32);
const base = { kind: 'snapshot' as const, source: 'synthetic_recovery', capturedAt: new Date().toISOString(), detail: {} };
const path = () => { const p = `${directory}/${randomUUID()}.crb`; files.push(p); return p; };
beforeAll(async () => { await mkdir(directory); });
afterAll(async () => { for (const p of files) await unlink(p).catch(() => {}); await rmdir(directory); });
it('round-trips large streamed entries without plaintext on disk and authenticates each delivered frame', async () => {
  const target = path(), source = Buffer.from('PRIVATE_RECOVERY_SENTINEL_'.repeat(10000));
  await createBundle(target, key, base, add => add('database', one(source)));
  expect((await readFile(target)).includes(Buffer.from('PRIVATE_RECOVERY_SENTINEL'))).toBe(false);
  const chunks: Buffer[] = []; const manifest = await inspectBundle(target, key, { async begin() {}, async data(bytes) { expect(bytes.length).toBeLessThanOrEqual(65536); chunks.push(bytes); }, async end() {} });
  expect(Buffer.concat(chunks)).toEqual(source); expect(manifest.entries[0]?.bytes).toBe(source.length);
});
it('rejects wrong keys, ciphertext/header edits, truncation and appended data', async () => {
  const source = path(); await createBundle(source, key, base, add => add('database', one(Buffer.from('small dump')))); const raw = await readFile(source);
  await expect(inspectBundle(source, randomBytes(32))).rejects.toThrow('authentication');
  const header = Buffer.from(raw), ciphertext = Buffer.from(raw); header[8] = header[8]! ^ 1; ciphertext[35] = ciphertext[35]! ^ 1;
  for (const variant of [header, ciphertext, raw.subarray(0, raw.length - 1), Buffer.concat([raw, Buffer.from('extra')])]) {
    const output = path(); await writeFile(output, variant); await expect(inspectBundle(output, key)).rejects.toThrow();
  }
});
it('rejects reordered/repeated valid frames and a missing final manifest', async () => {
  const source = path(); await createBundle(source, key, base, add => add('database', one(randomBytes(140000)))); const raw = await readFile(source);
  const firstEnd = 28 + 4 + raw.readUInt32BE(28) + 16, secondEnd = firstEnd + 4 + raw.readUInt32BE(firstEnd) + 16;
  for (const changed of [Buffer.concat([raw.subarray(0, 28), raw.subarray(firstEnd, secondEnd), raw.subarray(28, firstEnd), raw.subarray(secondEnd)]), Buffer.concat([raw.subarray(0, firstEnd), raw.subarray(28, firstEnd), raw.subarray(firstEnd)]), raw.subarray(0, secondEnd)]) { const output = path(); await writeFile(output, changed); await expect(inspectBundle(output, key)).rejects.toThrow(); }
});
it('enforces finite entries and JSON frame limits and never overwrites an existing bundle', async () => {
  const target = path(); await createBundle(target, key, base, add => add('database', one(Buffer.from('kept')))); const before = await readFile(target);
  await expect(createBundle(target, key, base, add => add('other', one(Buffer.from('overwrite'))))).rejects.toMatchObject({ code: 'EEXIST' }); expect(await readFile(target)).toEqual(before);
  const tooMany = path(); await expect(createBundle(tooMany, key, base, async add => { for (let n = 0; n <= limits.entries; n++) await add(`entry_${n}`, one(Buffer.alloc(0))); })).rejects.toThrow('entry');
  const tooLarge = path(); await expect(createBundle(tooLarge, key, { ...base, detail: { oversized: 'x'.repeat(65537) } }, async () => {})).rejects.toThrow('frame limit'); await expect(readFile(tooLarge)).rejects.toMatchObject({ code: 'ENOENT' });
});
it('validates key encoding and refuses nonignored artifact locations', async () => {
  for (const input of [undefined, 'private', 'aa'.repeat(31), 'GG'.repeat(32)]) expect(() => recoveryKey(input ?? '')).toThrow('RECOVERY_KEY');
  expect(recoveryKey(key.toString('hex'))).toEqual(key); await expect(privatePath('docs/plain-dump.crb')).rejects.toThrow('ignored'); await expect(privatePath('../outside.crb')).rejects.toThrow('ignored');
});
