import { randomUUID } from 'node:crypto';
import type { Channel, ConsumeMessage, Message } from 'amqplib';
import { brokerEventSchema } from '@chat/contracts';
import type { BrokerEvent } from '@chat/contracts';
import type { Db } from 'mongodb';
import type { ConversationService } from '../conversations/service.js';
import type { ControlEvent, OutboxRecord } from '../conversations/model.js';
import { longToSequence, sequenceToLong } from '../sequence.js';
import type { Admission, Effect, ProjectionJob, Subscription } from './model.js';
import { retryAttempt } from './broker.js';
import type { BrokerTransport } from './broker.js';
import { messagingSchemaReady } from './migrations.js';
export class InvalidBrokerEvent extends Error { constructor() { super('Invalid or expired event reference.'); } }
export class DeliveryStats { published = 0; relayErrors = 0; retries = 0; dead = 0; effects = 0; duplicates = 0; }
export function eventReference(event: ControlEvent): BrokerEvent { return brokerEventSchema.parse({ v: 1, eventId: event._id, conversationId: event.conversationId, sequence: longToSequence(event.sequence), kind: event.kind }); }
export class OutboxRelay {
  constructor(readonly service: ConversationService, readonly broker: BrokerTransport, readonly stats = new DeliveryStats()) {}
  async claim(): Promise<OutboxRecord | null> {
    if (!await messagingSchemaReady(this.service.db)) return null;
    return this.service.db.collection<OutboxRecord>('outbox').findOneAndUpdate({ $or: [
      { status: 'pending', $expr: { $lte: ['$availableAt', '$$NOW'] } }, { status: 'claimed', $expr: { $lte: ['$leaseUntil', '$$NOW'] } }
    ] }, [{ $set: { status: 'claimed', leaseOwner: randomUUID(), leaseUntil: { $dateAdd: { startDate: '$$NOW', unit: 'second', amount: 30 } }, attempts: { $add: ['$attempts', 1] } } }], { sort: { availableAt: 1, createdAt: 1 }, returnDocument: 'after' });
  }
  async complete(row: OutboxRecord) {
    await this.service.run(async session => {
      await this.service.db.collection<Admission>('outboxAdmission').updateOne({ _id: 'global' }, { $inc: { guardVersion: 1 } }, { session });
      const changed = await this.service.db.collection<OutboxRecord>('outbox').updateOne({ _id: row._id, status: 'claimed', leaseOwner: row.leaseOwner, $expr: { $gt: ['$leaseUntil', '$$NOW'] } }, { $set: { status: 'published', publishedAt: new Date(), leaseUntil: new Date(0), leaseOwner: null } }, { session });
      if (!changed.matchedCount) throw new Error('Outbox publication lease was lost');
    }); this.stats.published++;
  }
  async runOnce() {
    const row = await this.claim(); if (!row) return false;
    try {
      const event = await this.service.db.collection<ControlEvent>('conversationEvents').findOne({ _id: row.eventId });
      if (!event) throw new InvalidBrokerEvent();
      const reference = eventReference(event);
      await this.broker.publish(this.broker.prefix, '', Buffer.from(JSON.stringify(reference)), { messageId: reference.eventId, type: 'conversation.event.v1' });
      await this.complete(row); return true;
    } catch {
      this.stats.relayErrors++;
      await this.service.db.collection<OutboxRecord>('outbox').updateOne({ _id: row._id, status: 'claimed', leaseOwner: row.leaseOwner }, { $set: { status: 'pending', leaseOwner: null, leaseUntil: new Date(0), availableAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(row.attempts, 5)) + Math.floor(Math.random() * 250)) } });
      throw new Error('Outbox publication delayed');
    }
  }
}
export class EventConsumer {
  private inFlight = new Set<Promise<void>>(); private channel?: Channel; private tag?: string;
  constructor(readonly service: ConversationService, readonly broker: BrokerTransport, readonly subscription: Subscription, readonly stats = new DeliveryStats()) {}
  async apply(reference: BrokerEvent): Promise<boolean> {
    return this.service.run(async session => {
      const canonical = await this.service.db.collection<ControlEvent>('conversationEvents').findOne({ _id: reference.eventId }, { session });
      if (!canonical || JSON.stringify(eventReference(canonical)) !== JSON.stringify(reference) || canonical.createdAt.getTime() < Date.now() - this.service.auth.config.EFFECT_RETENTION_DAYS * 86400000) throw new InvalidBrokerEvent();
      const effects = this.service.db.collection<Effect>('consumerEffects'), key = `${this.subscription}:${reference.eventId}`;
      if (await effects.findOne({ _id: key }, { session })) return false;
      await effects.insertOne({ _id: key, schemaVersion: 1, eventId: reference.eventId, subscription: this.subscription, createdAt: new Date() }, { session });
      if (this.subscription === 'fanout' || reference.kind === 'message.created') {
        await this.service.db.collection<Admission>('outboxAdmission').updateOne({ _id: `projection:${this.subscription}` }, { $inc: { guardVersion: 1 } }, { session });
        const jobs = this.service.db.collection<ProjectionJob>(this.subscription === 'fanout' ? 'fanoutJobs' : 'notificationJobs');
        if (await jobs.countDocuments({ state: 'pending' }, { session, limit: this.service.auth.config.MAX_PENDING_PROJECTIONS }) >= this.service.auth.config.MAX_PENDING_PROJECTIONS) throw new Error('Projection backlog is full');
        await jobs.insertOne({ _id: reference.eventId, schemaVersion: 1, eventId: reference.eventId, conversationId: reference.conversationId, sequence: sequenceToLong(reference.sequence), state: 'pending', createdAt: new Date() }, { session });
      }
      return true;
    });
  }
  async process(message: Message, channel: Channel) {
    try {
      if (message.content.length > this.service.auth.config.MAX_SOCKET_BYTES) throw new InvalidBrokerEvent();
      let raw: unknown; try { raw = JSON.parse(message.content.toString('utf8')); } catch { throw new InvalidBrokerEvent(); }
      const parsed = brokerEventSchema.safeParse(raw); if (!parsed.success || message.properties.messageId !== parsed.data.eventId) throw new InvalidBrokerEvent();
      const changed = await this.apply(parsed.data); if (changed) this.stats.effects++; else this.stats.duplicates++;
      channel.ack(message);
    } catch (error) {
      const next = retryAttempt(message) + 1, permanent = error instanceof InvalidBrokerEvent;
      if (permanent || next > this.service.auth.config.BROKER_RETRY_ATTEMPTS) {
        await this.broker.publish(`${this.broker.prefix}.dead`, this.subscription, message.content, { messageId: message.properties.messageId ?? randomUUID(), headers: { 'x-app-attempt': next, 'x-app-reason': permanent ? 'INVALID_EVENT' : 'RETRIES_EXHAUSTED' } }); this.stats.dead++;
      } else {
        await this.broker.publish(`${this.broker.prefix}.retry`, `${this.subscription}.${next}`, message.content, { messageId: message.properties.messageId ?? randomUUID(), headers: { 'x-app-attempt': next } }); this.stats.retries++;
      }
      // A failed handoff leaves the original unacknowledged; connection recovery redelivers it.
      channel.ack(message);
    }
  }
  async start() {
    this.channel = await this.broker.channel(); const channel = this.channel;
    const reply = await channel.consume(this.broker.queue(this.subscription), (message: ConsumeMessage | null) => {
      if (!message) { void this.broker.close(); return; }
      const operation = this.process(message, channel).catch(async () => { await this.broker.close(); }).finally(() => { this.inFlight.delete(operation); });
      this.inFlight.add(operation);
    }, { noAck: false }); this.tag = reply.consumerTag;
  }
  async stop() { if (this.channel && this.tag) await this.channel.cancel(this.tag).catch(() => {}); await Promise.allSettled([...this.inFlight]); }
}
export async function deliveryMetrics(db: Db, stats: DeliveryStats): Promise<string> {
  const rows = db.collection<OutboxRecord>('outbox'), query = { status: { $in: ['pending', 'claimed'] as OutboxRecord['status'][] } };
  const count = await rows.countDocuments(query), oldest = await rows.find(query).sort({ createdAt: 1 }).limit(1).next();
  return `chat_outbox_pending ${count}\nchat_outbox_oldest_age_seconds ${oldest ? Math.max(0, (Date.now() - oldest.createdAt.getTime()) / 1000) : 0}\nchat_outbox_publications_total ${stats.published}\nchat_outbox_failures_total ${stats.relayErrors}\nchat_consumer_retries_total ${stats.retries}\nchat_consumer_dead_letters_total ${stats.dead}\nchat_consumer_effects_total ${stats.effects}\nchat_consumer_duplicates_total ${stats.duplicates}\n`;
}
