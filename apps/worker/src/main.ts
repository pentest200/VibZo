import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '@chat/config';
import { startFoundationProcess, createLogger } from '@chat/observability';
import { createMongoClient, AuthEmailWorker, AuthService, ConversationService, authSchemaReady, messagingSchemaReady, BrokerTransport, OutboxRelay, EventConsumer, DeliveryStats, deliveryMetrics, inspectMongo } from '@chat/domain';
const config = loadConfig(), client = createMongoClient(config), db = client.db(config.MONGODB_DATABASE);
const email = new AuthEmailWorker(db, config), logger = createLogger('worker', config.LOG_LEVEL);
const conversations = new ConversationService(new AuthService(config, client, db)), stats = new DeliveryStats();
let stopped = false, ready = false, broker: BrokerTransport | undefined, consumers: EventConsumer[] = [];
const shutdown = new AbortController(); let deadline: ReturnType<typeof setTimeout> | undefined;
const server = await startFoundationProcess('worker', config.HOST, config.WORKER_PORT, config.LOG_LEVEL, { ready: () => ready && !broker?.failed && !stopped, metrics: () => deliveryMetrics(db, stats) });
const stop = () => {
  if (stopped) return; stopped = true; ready = false; shutdown.abort(); server.close();
  deadline = setTimeout(() => process.exit(1), 10000).unref();
};
process.once('SIGTERM', stop); process.once('SIGINT', stop);
const pause = async (milliseconds: number) => { await delay(milliseconds, undefined, { signal: shutdown.signal }).catch(() => {}); };
async function accountMaintenance() {
  while (!stopped) {
    try { if (await authSchemaReady(db)) { await email.runOnce(); await conversations.expireInvitationsOnce(); } }
    catch { logger.warn({ code: 'MAINTENANCE_DELAYED' }, 'account maintenance delayed'); }
    await pause(1000);
  }
}
async function durableDelivery() {
  let failures = 0;
  while (!stopped) {
    try {
      if (await messagingSchemaReady(db)) {
        if (!broker || broker.failed) {
          for (const consumer of consumers) await consumer.stop();
          await broker?.close(); broker = await BrokerTransport.open(config);
          consumers = ['fanout', 'notification'].map(subscription => new EventConsumer(conversations, broker!, subscription as 'fanout' | 'notification', stats));
          for (const consumer of consumers) await consumer.start();
        }
        const relay = new OutboxRelay(conversations, broker, stats);
        for (let count = 0; count < config.JOB_CONCURRENCY && !stopped; count++) if (!await relay.runOnce()) break;
        ready = await inspectMongo(client); failures = 0;
      } else ready = false;
    } catch {
      ready = false; failures++; logger.warn({ code: 'DELIVERY_DELAYED' }, 'durable delivery delayed');
      for (const consumer of consumers) await consumer.stop(); consumers = [];
      await broker?.close(); broker = undefined;
    }
    await pause(failures ? Math.min(30000, 500 * 2 ** Math.min(failures, 6)) + Math.floor(Math.random() * 250) : 250);
  }
}
try { await Promise.all([accountMaintenance(), durableDelivery()]); }
finally {
  ready = false; for (const consumer of consumers) await consumer.stop();
  await broker?.close(); await client.close(); if (deadline) clearTimeout(deadline);
}
