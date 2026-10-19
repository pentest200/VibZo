import { randomUUID } from 'node:crypto';
import { connect } from 'amqplib';
import type { Channel, ChannelModel, ConfirmChannel, Message, Options } from 'amqplib';
import type { Config } from '@chat/config';
import type { Subscription } from './model.js';
export const subscriptions: Subscription[] = ['fanout', 'notification'];
export class BrokerUnavailable extends Error { constructor() { super('Broker publication is unavailable.'); } }
export class BrokerTransport {
  readonly prefix: string;
  private connection!: ChannelModel;
  private publisher!: ConfirmChannel;
  private channels: Channel[] = [];
  private released = new WeakSet<Channel>();
  private pending = new Map<string, { reject: (error: Error) => void }>();
  failed = false;
  private constructor(readonly config: Config) { this.prefix = `${config.BROKER_NAMESPACE}.${config.MONGODB_DATABASE}`; }
  queue(subscription: Subscription) { return `${this.prefix}.${subscription}`; }
  static async open(config: Config): Promise<BrokerTransport> {
    const broker = new BrokerTransport(config);
    try {
      const url = new URL(config.RABBITMQ_URL); url.searchParams.set('heartbeat', '10');
      broker.connection = await connect(url.toString(), { timeout: config.DEPENDENCY_TIMEOUT_MS });
      broker.connection.on('error', () => broker.fail()); broker.connection.on('close', () => broker.fail());
      broker.publisher = await broker.connection.createConfirmChannel();
      broker.publisher.on('error', () => broker.fail()); broker.publisher.on('close', () => broker.fail());
      broker.publisher.on('return', message => { const id = message.properties.correlationId; if (id) broker.pending.get(id)?.reject(new BrokerUnavailable()); });
      await broker.topology(); return broker;
    } catch { await broker.close(); throw new BrokerUnavailable(); }
  }
  private fail() { this.failed = true; for (const pending of this.pending.values()) pending.reject(new BrokerUnavailable()); }
  private async topology() {
    const channel = this.publisher;
    await channel.assertExchange(this.prefix, 'fanout', { durable: true });
    await channel.assertExchange(`${this.prefix}.retry`, 'direct', { durable: true });
    await channel.assertExchange(`${this.prefix}.dead`, 'direct', { durable: true });
    await channel.assertExchange(`${this.prefix}.resume`, 'direct', { durable: true });
    const bounded = { 'x-queue-type': 'quorum', 'x-max-length': this.config.BROKER_QUEUE_LIMIT, 'x-overflow': 'reject-publish' };
    for (const subscription of subscriptions) {
      const queue = this.queue(subscription);
      await channel.assertQueue(`${queue}.dead`, { durable: true, arguments: bounded });
      await channel.bindQueue(`${queue}.dead`, `${this.prefix}.dead`, subscription);
      await channel.assertQueue(queue, { durable: true, arguments: { ...bounded, 'x-delivery-limit': 20,
        'x-dead-letter-exchange': `${this.prefix}.dead`, 'x-dead-letter-routing-key': subscription, 'x-dead-letter-strategy': 'at-least-once' } });
      await channel.bindQueue(queue, this.prefix, ''); await channel.bindQueue(queue, `${this.prefix}.resume`, subscription);
      for (let attempt = 1; attempt <= this.config.BROKER_RETRY_ATTEMPTS; attempt++) {
        const key = `${subscription}.${attempt}`;
        await channel.assertQueue(`${queue}.retry.${attempt}`, { durable: true, arguments: { ...bounded,
          'x-message-ttl': Math.min(60000, this.config.BROKER_RETRY_BASE_MS * 2 ** (attempt - 1)),
          'x-dead-letter-exchange': `${this.prefix}.resume`, 'x-dead-letter-routing-key': subscription, 'x-dead-letter-strategy': 'at-least-once' } });
        await channel.bindQueue(`${queue}.retry.${attempt}`, `${this.prefix}.retry`, key);
      }
    }
  }
  async channel(): Promise<Channel> {
    if (this.failed) throw new BrokerUnavailable();
    const channel = await this.connection.createChannel(); this.channels.push(channel);
    channel.on('error', () => this.fail()); channel.on('close', () => { if (!this.released.has(channel) && !this.failed) this.fail(); });
    await channel.prefetch(Math.min(this.config.BROKER_PREFETCH, this.config.JOB_CONCURRENCY)); return channel;
  }
  async releaseChannel(channel: Channel) {
    if (!this.channels.includes(channel)) throw new Error('Broker does not own channel');
    this.released.add(channel);
    try { await channel.close(); }
    catch { this.fail(); }
    finally { this.channels = this.channels.filter(owned => owned !== channel); }
  }
  async publish(exchange: string, routingKey: string, content: Buffer, options: Options.Publish = {}): Promise<void> {
    if (this.failed || this.pending.size >= 256 || content.length > this.config.MAX_SOCKET_BYTES) throw new BrokerUnavailable();
    const correlationId = randomUUID();
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => { clearTimeout(timer); this.pending.delete(correlationId); if (error) reject(error); else resolve(); };
      const timer = setTimeout(() => { finish(new BrokerUnavailable()); this.fail(); void this.close(); }, 5000);
      this.pending.set(correlationId, { reject: error => finish(error) });
      try { this.publisher.publish(exchange, routingKey, content, { ...options, persistent: true, mandatory: true, correlationId, contentType: 'application/json' }, error => finish(error ? new BrokerUnavailable() : undefined)); }
      catch { finish(new BrokerUnavailable()); this.fail(); }
    });
  }
  async close() {
    this.fail();
    await Promise.allSettled(this.channels.map(channel => channel.close())); this.channels = [];
    if (this.publisher) await this.publisher.close().catch(() => {});
    if (this.connection) await this.connection.close().catch(() => {});
  }
  async deleteTestTopology() {
    if (this.config.NODE_ENV !== 'test') throw new Error('Topology cleanup is test-only');
    for (const subscription of subscriptions) {
      for (let attempt = 1; attempt <= this.config.BROKER_RETRY_ATTEMPTS; attempt++) await this.publisher.deleteQueue(`${this.queue(subscription)}.retry.${attempt}`);
      await this.publisher.deleteQueue(this.queue(subscription)); await this.publisher.deleteQueue(`${this.queue(subscription)}.dead`);
    }
    for (const suffix of ['', '.retry', '.dead', '.resume']) await this.publisher.deleteExchange(`${this.prefix}${suffix}`);
  }
}
export const retryAttempt = (message: Message): number => {
  const value: unknown = message.properties.headers?.['x-app-attempt'];
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 5 ? value : 0;
};
