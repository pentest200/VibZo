import { createHash, createHmac, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from 'node:crypto';
import * as argon2 from 'argon2';
import type { Config } from '@chat/config';
import { unavailable } from './errors.js';
export const newToken = () => randomBytes(32).toString('base64url');
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
export const csrfFor = (token: string, secret: string) => createHmac('sha256', secret).update(`csrf:${token}`).digest('base64url');
export function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
export function seal(value: string, secret: string): string {
  const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function unseal(value: string, secret: string): string {
  const bytes = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
export class PasswordHasher {
  private running = 0;
  private dummyHash = '';
  constructor(private readonly config: Config) {}
  async initialize(): Promise<void> { this.dummyHash = await this.hash(newToken()); }
  private async bounded<T>(operation: () => Promise<T>): Promise<T> {
    if (this.running >= this.config.AUTH_HASH_CONCURRENCY) throw unavailable();
    this.running++;
    try { return await operation(); } finally { this.running--; }
  }
  hash(password: string): Promise<string> {
    return this.bounded(() => argon2.hash(password, { type: argon2.argon2id, memoryCost: this.config.ARGON_MEMORY_KIB,
      timeCost: this.config.ARGON_TIME_COST, parallelism: this.config.ARGON_PARALLELISM, hashLength: 32 }));
  }
  async verify(hash: string | undefined, password: string): Promise<boolean> {
    const matches = await this.bounded(() => argon2.verify(hash ?? this.dummyHash, password));
    return !!hash && matches;
  }
}
