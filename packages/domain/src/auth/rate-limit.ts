import { createClient } from 'redis';
import type { Config } from '@chat/config';
import { tokenHash } from './crypto.js';
import { DomainError, unavailable } from './errors.js';

const script = `local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]); end; return n`;
export class AuthRateLimiter {
  private readonly client;
  private connecting: Promise<void> | undefined;
  constructor(private readonly config: Config) {
    this.client = createClient({ url: config.REDIS_URL, disableOfflineQueue: true, commandsQueueMaxLength: 100,
      socket: { reconnectStrategy: false, connectTimeout: config.DEPENDENCY_TIMEOUT_MS } });
    this.client.on('error', () => { /* fail closed via command result; never log credentials */ });
  }
  async connect(): Promise<void> {
    if (this.client.isReady) return;
    if (!this.connecting) this.connecting = this.client.connect().then(() => {}).finally(() => { this.connecting = undefined; });
    await this.connecting;
  }
  async ready(): Promise<boolean> { try { return this.client.isReady && await this.client.withCommandOptions({ timeout: this.config.DEPENDENCY_TIMEOUT_MS }).ping() === 'PONG'; } catch { return false; } }
  async consume(identity: string, limit = this.config.AUTH_RATE_LIMIT, seconds = this.config.AUTH_RATE_WINDOW_SECONDS): Promise<void> {
    if (!this.client.isReady) { try { await this.connect(); } catch { throw unavailable(); } }
    let count: unknown;
    try { count = await this.client.withCommandOptions({ timeout: this.config.DEPENDENCY_TIMEOUT_MS }).eval(script, { keys: [`auth:${this.config.MONGODB_DATABASE}:${tokenHash(identity)}`], arguments: [String(seconds)] }); }
    catch { throw unavailable(); }
    if (typeof count !== 'number') throw unavailable();
    if (count > limit) throw new DomainError('RATE_LIMITED', 'Too many attempts. Please try again later.', 429, true);
  }
  async revocationHint(userId: string): Promise<void> {
    try { if (this.client.isReady) await this.client.withCommandOptions({ timeout: this.config.DEPENDENCY_TIMEOUT_MS }).publish('auth.revoked.v1', JSON.stringify({ userId })); }
    catch { /* durable authority is Mongo; missed hint must not preserve permissions */ }
  }
  async close(): Promise<void> { if (this.client.isOpen) this.client.destroy(); }
}
