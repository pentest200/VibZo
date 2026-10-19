import { randomUUID } from 'node:crypto';
import { traced, observeProjectionLag } from '@chat/observability';
import { createClient } from 'redis';
import type { Config } from '@chat/config';
import { brokerEventSchema } from '@chat/contracts';
import type { BrokerEvent } from '@chat/contracts';
import type { Db } from 'mongodb';
import type { ProjectionJob } from '../messaging/model.js';
import type { ControlEvent } from '../conversations/model.js';
import { eventReference } from '../messaging/delivery.js';
import { syncSchemaReady } from './migrations.js';
export const syncChannel = (config: Config) => `${config.BROKER_NAMESPACE}.${config.MONGODB_DATABASE}.sync`;
export class FanoutWorker {
  private redis: ReturnType<typeof createClient>;
  constructor(readonly db: Db, readonly config: Config) {
    this.redis = createClient({ url: config.REDIS_URL, disableOfflineQueue: true, commandsQueueMaxLength: 128, socket: { connectTimeout: config.DEPENDENCY_TIMEOUT_MS, reconnectStrategy: retries => Math.min(3000, 100 * 2 ** Math.min(5, retries)) } });
    this.redis.on('error', () => {});
  }
  get ready() { return this.redis.isReady; }
  async runOnce() {
    if (!await syncSchemaReady(this.db)) return false;
    if (!this.redis.isOpen) await this.redis.connect(); if (!this.redis.isReady) throw new Error('Fanout Redis unavailable');
    const owner = randomUUID(), jobs = this.db.collection<ProjectionJob>('fanoutJobs');
    const row = await jobs.findOneAndUpdate({ $or: [{ state: 'pending' }, { state: 'claimed', $expr: { $lte: ['$leaseUntil', '$$NOW'] } }] }, [{ $set: { state: 'claimed', leaseOwner: owner, leaseUntil: { $dateAdd: { startDate: '$$NOW', unit: 'second', amount: 30 } } } }], { sort: { createdAt: 1 }, returnDocument: 'after' });
    if (!row) return false;
    const source = await this.db.collection<{ _id: string; traceparent?: string }>('outbox').findOne({ _id: row.eventId }, { projection: { traceparent: 1 } });
    return traced('fanout.publish', {}, async () => {
      try {
        const canonical = await this.db.collection<ControlEvent>('conversationEvents').findOne({ _id: row.eventId }); if (!canonical) throw new Error('Canonical event missing');
        const reference = eventReference(canonical);
        await this.redis.withCommandOptions({ timeout: this.config.DEPENDENCY_TIMEOUT_MS }).publish(syncChannel(this.config), JSON.stringify(reference));
        const result = await jobs.updateOne({ _id: row._id, state: 'claimed', leaseOwner: owner, $expr: { $gt: ['$leaseUntil', '$$NOW'] } }, { $set: { state: 'published', leaseOwner: null, leaseUntil: new Date(0), publishedAt: new Date() } });
        if (!result.matchedCount) throw new Error('Fanout lease lost'); observeProjectionLag(Math.max(0, (Date.now() - canonical.createdAt.getTime()) / 1000)); return true;
      } catch { await jobs.updateOne({ _id: row._id, state: 'claimed', leaseOwner: owner }, { $set: { state: 'pending', leaseOwner: null, leaseUntil: new Date(0) } }); throw new Error('Fanout delayed'); }
    }, source?.traceparent);
  }
  async close() { if (this.redis.isOpen) this.redis.destroy(); }
}
export function parseFanout(raw: string): BrokerEvent | null { try { const result = brokerEventSchema.safeParse(JSON.parse(raw)); return result.success ? result.data : null; } catch { return null; } }
