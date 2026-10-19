import { setTimeout as delay } from 'node:timers/promises';
import { loadConfig } from '@chat/config';
import { startFoundationProcess, createLogger, startTelemetry, DrainTracker, traced, operationalMetrics, recordOperational } from '@chat/observability';
import { createMongoClient, CallService, CallWorker, callMetrics, AttachmentService, AttachmentWorker, FanoutWorker, AuthEmailWorker, AuthService, ConversationService, SafetyService, SafetyMaintenance, NotificationWorker, authSchemaReady, messagingSchemaReady, BrokerTransport, OutboxRelay, EventConsumer, DeliveryStats, deliveryMetrics, attachmentMetrics, inspectMongo, mongoPoolMetrics } from '@chat/domain';
const config = loadConfig(), client = createMongoClient(config), db = client.db(config.MONGODB_DATABASE);
const telemetry = startTelemetry('worker', config), work = new DrainTracker();
const job = <T>(name: string, run: () => Promise<T>) => stopped ? Promise.resolve(undefined) : work.run(() => traced(name, {}, run).catch(error => { recordOperational('worker_failure'); throw error; }));
const email = new AuthEmailWorker(db, config), logger = createLogger('worker', config.LOG_LEVEL);
const conversations = new ConversationService(new AuthService(config, client, db)), stats = new DeliveryStats();
let stopped = false, ready = false, drainStartedAt = 0, broker: BrokerTransport | undefined, consumers: EventConsumer[] = [];
const attachments = new AttachmentService(conversations.auth), attachmentWorker = new AttachmentWorker(attachments);
const fanout = new FanoutWorker(db, config);
const calls = new CallService(conversations.auth), callWorker = new CallWorker(calls);
const safety = new SafetyService(conversations.auth), notifications = new NotificationWorker(safety), maintenance = new SafetyMaintenance(safety);
const shutdown = new AbortController(); let deadline: ReturnType<typeof setTimeout> | undefined;
const server = await startFoundationProcess('worker', config.HOST, config.WORKER_PORT, config.LOG_LEVEL, { managedShutdown: true, ready: () => ready && fanout.ready && !broker?.failed && !stopped, metrics: async () => `${await operationalMetrics()}${mongoPoolMetrics(client)}chat_process_draining ${stopped ? 1 : 0}\nchat_worker_inflight ${work.active}\n${await deliveryMetrics(db, stats)}${await attachmentMetrics(db)}${await callMetrics(calls)}chat_fanout_ready ${fanout.ready ? 1 : 0}\nchat_fanout_pending ${await db.collection('fanoutJobs').countDocuments({ state: { $in: ['pending', 'claimed'] } })}\n` });
const stop = () => {
  if (stopped) return; stopped = true; ready = false; drainStartedAt = Date.now(); shutdown.abort();
  for (const consumer of consumers) void consumer.stopIntake();
  deadline = setTimeout(() => process.exit(1), config.DRAIN_TIMEOUT_MS + config.DRAIN_DELAY_MS + 2500).unref();
};
process.once('SIGTERM', stop); process.once('SIGINT', stop);
const pause = async (milliseconds: number) => { await delay(milliseconds, undefined, { signal: shutdown.signal }).catch(() => {}); };
async function accountMaintenance() {
  while (!stopped) {
    try { if (await authSchemaReady(db)) { await job('email.process', () => email.runOnce()); await job('invitation.expire', () => conversations.expireInvitationsOnce()); } }
    catch { logger.warn({ code: 'MAINTENANCE_DELAYED' }, 'account maintenance delayed'); }
    await pause(1000);
  }
}
async function attachmentChecks() {
  let nextCleanup = 0;
  while (!stopped) {
    try {
      await job('attachment.process', () => attachmentWorker.runOnce());
      if (!stopped && Date.now() >= nextCleanup) { await job('attachment.maintenance', () => attachmentWorker.maintenanceOnce()); nextCleanup = Date.now() + 10000; }
    } catch { logger.warn({ code: 'ATTACHMENT_DELAYED' }, 'file checks delayed'); }
    await pause(1000);
  }
}
async function safetyWork() {
  while (!stopped) {
    for (const task of [() => notifications.expandOnce(), () => notifications.runOnce(), () => maintenance.deletionOnce(), () => maintenance.retentionOnce(), () => maintenance.eventRetentionOnce(), () => maintenance.inboxRetentionOnce()]) {
      if (stopped) break;
      try { await job('safety.process', task); } catch { logger.warn({ code: 'SAFETY_DELAYED' }, 'safety maintenance delayed'); }
    }
    await pause(1000);
  }
}
async function mediaReconciliation() {
  while (!stopped) {
    try { await job('call.webhook', () => callWorker.webhookOnce()); for (let n = 0; n < config.JOB_CONCURRENCY && !stopped; n++) if (!await job('call.reconcile', () => callWorker.runOnce())) break; }
    catch { logger.warn({ code: 'MEDIA_RECONCILIATION_DELAYED' }, 'call reconciliation delayed'); }
    await pause(1000);
  }
}
async function liveDelivery() {
  while (!stopped) {
    try { for (let count = 0; count < config.JOB_CONCURRENCY && !stopped; count++) if (!await job('fanout.process', () => fanout.runOnce())) break; }
    catch { logger.warn({ code: 'FANOUT_DELAYED' }, 'live hints delayed'); }
    await pause(100);
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
          if (stopped) break;
          consumers = ['fanout', 'notification'].map(subscription => new EventConsumer(conversations, broker!, subscription as 'fanout' | 'notification', stats));
          for (const consumer of consumers) { if (stopped) break; await consumer.start(); }
        }
        const relay = new OutboxRelay(conversations, broker, stats);
        for (let count = 0; count < config.JOB_CONCURRENCY && !stopped; count++) if (!await job('outbox.process', () => relay.runOnce())) break;
        ready = !stopped && await inspectMongo(client); failures = 0;
      } else ready = false;
    } catch {
      ready = false; failures++; logger.warn({ code: 'DELIVERY_DELAYED' }, 'durable delivery delayed');
      for (const consumer of consumers) await consumer.stop(); consumers = [];
      await broker?.close(); broker = undefined;
    }
    await pause(failures ? Math.min(30000, 500 * 2 ** Math.min(failures, 6)) + Math.floor(Math.random() * 250) : 250);
  }
}
try { await Promise.all([accountMaintenance(), durableDelivery(), liveDelivery(), attachmentChecks(), safetyWork(), mediaReconciliation()]); }
finally {
  ready = false; for (const consumer of consumers) await consumer.stop();
  if (drainStartedAt) await delay(Math.max(0, config.DRAIN_DELAY_MS - (Date.now() - drainStartedAt)));
  attachments.close(); await fanout.close(); await broker?.close(); await client.close(); await telemetry.close(); server.close(); if (deadline) clearTimeout(deadline);
}
