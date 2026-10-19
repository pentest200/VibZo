import { connect as tcpConnect } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { connect as amqpConnect } from 'amqplib';
import { createClient } from 'redis';
import { S3Client, HeadBucketCommand } from '@aws-sdk/client-s3';
import { RoomServiceClient } from 'livekit-server-sdk';
import type { Config } from '@chat/config';
import { createMongoClient } from '../mongo.js';

export const dependencies = ['mongodb', 'redis', 'rabbitmq', 'storage', 'scanner', 'image', 'livekit', 'smtp', 'push'] as const;
type Dependency = typeof dependencies[number];
interface Observation { enabled: boolean; observed: boolean; up: boolean; last: number; failures: number; next: number; details: string }
export async function boundedText(url: string | URL, timeout: number, max = 1048576, headers?: Record<string, string>) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeout), redirect: 'error', ...(headers ? { headers } : {}) });
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Inspection unavailable'); }
  const reader = response.body.getReader(), parts: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > max) throw new Error('Inspection limit'); parts.push(next.value); }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(parts).toString('utf8');
}
export function protocolProbe(host: string, port: number, timeout: number, kind: 'scanner' | 'smtp', secure = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = secure ? tlsConnect({ host, port, rejectUnauthorized: true }) : tcpConnect({ host, port });
    let buffer = '', stage = 0, settled = false;
    const finish = (ok: boolean) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); if (ok) resolve(); else reject(new Error('Protocol inspection unavailable')); };
    const timer = setTimeout(() => finish(false), timeout);
    socket.once('error', () => finish(false)); socket.once('close', () => { if (!settled) finish(false); });
    socket.once(secure ? 'secureConnect' : 'connect', () => { if (kind === 'scanner') socket.write('zPING\0'); });
    socket.on('data', chunk => {
      buffer += chunk.toString('utf8'); if (buffer.length > 8192) { finish(false); return; }
      if (kind === 'scanner') { if (buffer.includes('\0')) finish(buffer === 'PONG\0'); return; }
      for (;;) {
        const end = buffer.indexOf('\r\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (stage === 0 && /^220 /.test(line)) { stage = 1; socket.write('EHLO monitor.example.test\r\n'); }
        else if (stage === 1 && /^250 /.test(line)) { stage = 2; socket.write('QUIT\r\n'); }
        else if (stage === 2 && /^221 /.test(line)) finish(true);
        else if (/^[45]\d\d /.test(line)) finish(false);
      }
    });
  });
}
const queues = [
  ['outbox', 'outbox', 'status', ['pending', 'claimed'], []],
  ['fanout', 'fanoutJobs', 'state', ['pending', 'claimed'], []],
  ['notification', 'notificationJobs', 'state', ['pending', 'claimed'], []],
  ['attachment', 'attachmentJobs', 'state', ['pending', 'claimed'], ['failed']],
  ['push', 'pushJobs', 'state', ['pending', 'claimed'], ['failed']],
  ['email', 'authEmailJobs', 'state', ['pending', 'sending'], ['dead']],
  ['deletion', 'deletionJobs', 'state', ['pending', 'claimed'], ['failed']]
] as const;
const mediaNames: Record<string, string> = {
  livekit_bytes_in: 'bytes_in', livekit_bytes_out: 'bytes_out', livekit_packets_in: 'packets_in', livekit_packets_out: 'packets_out',
  livekit_packet_bytes: 'packet_bytes', livekit_packet_total: 'packets', livekit_participant_total: 'participants', livekit_room_total: 'rooms',
  livekit_node_packet_total: 'packets_all_directions', livekit_room_duration_seconds_sum: 'completed_room_seconds', livekit_room_duration_seconds_count: 'completed_rooms', livekit_forward_latency_ns_sum: 'forward_latency_ns_sum', livekit_forward_latency_ns_count: 'forward_latency_samples', livekit_quality_score_sum: 'quality_score_sum', livekit_quality_score_count: 'quality_score_samples', livekit_packets_lost: 'packets_lost', livekit_rtcp_rtt: 'rtcp_rtt'
};
// Drop all provider labels/identities. Missing names are unobserved, never zero.
export function aggregateMediaMetrics(text: string) {
  const sums = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^([a-zA-Z_:][\w:]*)(?:\{[^\n]*\})?\s+([\d.eE+-]+)(?:\s+\d+)?$/.exec(line);
    const key = match?.[1] && mediaNames[match[1]], value = Number(match?.[2]);
    if (key && Number.isFinite(value) && value >= 0) sums.set(key, (sums.get(key) ?? 0) + value);
  }
  return Object.values(mediaNames).map(key => `chat_media_metric_observed{metric="${key}"} ${sums.has(key) ? 1 : 0}\n${sums.has(key) ? `chat_media_aggregate{metric="${key}"} ${sums.get(key)}\n` : ''}`).join('');
}
export class OperationsMonitor {
  private readonly mongo; private readonly storage; private readonly media;
  private running: Promise<string> | undefined;
  readonly states: Record<Dependency, Observation>;
  constructor(readonly config: Config, readonly backoffCap = 30000) {
    if (!Number.isInteger(backoffCap) || backoffCap < 100 || backoffCap > 30000) throw new Error('Invalid probe budget');
    const timeout = config.OPERATIONS_PROBE_TIMEOUT_MS;
    this.mongo = createMongoClient({ ...config, MONGODB_POOL_SIZE: 2, DEPENDENCY_TIMEOUT_MS: timeout });
    this.storage = new S3Client({ endpoint: config.S3_ENDPOINT, region: config.S3_REGION, forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY }, requestHandler: { connectionTimeout: timeout, requestTimeout: timeout } });
    this.media = new RoomServiceClient(config.LIVEKIT_API_URL, config.LIVEKIT_API_KEY, config.LIVEKIT_API_SECRET, { requestTimeout: timeout / 1000, failover: false });
    this.states = Object.fromEntries(dependencies.map(name => [name, { enabled: name === 'push' ? config.PUSH_ENABLED : name !== 'livekit' || config.CALLS_ENABLED, observed: false, up: false, last: 0, failures: 0, next: 0, details: '' }])) as Record<Dependency, Observation>;
  }
  async inspect(name: Dependency, probe: () => Promise<string>) {
    const state = this.states[name]; if (!state.enabled || Date.now() < state.next) return;
    try { state.details = await probe(); state.up = true; state.failures = 0; state.next = 0; }
    catch { state.up = false; state.details = ''; state.failures++; state.next = state.failures < 3 ? 0 : Date.now() + Math.min(this.backoffCap, 1000 * 2 ** Math.min(5, state.failures - 3)) + Math.floor(Math.random() * 100); }
    state.observed = true; state.last = Date.now();
  }
  tick() { return this.running ??= this.capture().finally(() => { this.running = undefined; }); }
  private async capture() {
    const c = this.config, timeout = c.OPERATIONS_PROBE_TIMEOUT_MS;
    await Promise.all([
      this.inspect('mongodb', async () => {
        const hello = await this.mongo.db('admin').command({ hello: 1 }, { timeoutMS: timeout });
        if (hello['isWritablePrimary'] !== true || typeof hello['setName'] !== 'string') throw new Error('Primary unavailable');
        try {
          const status = await this.mongo.db('admin').command({ replSetGetStatus: 1 }, { timeoutMS: timeout });
          const members = status['members'] as { health: number; state: number; optimeDate?: Date }[];
          if (!Array.isArray(members) || !members.length) throw new Error('No replication observation');
          const primary = members.find(m => m.state === 1)?.optimeDate?.getTime();
          const secondary = members.filter(m => m.state === 2 && m.health === 1 && m.optimeDate instanceof Date);
          return `chat_mongo_replication_observed 1\nchat_mongo_members ${members.length}\nchat_mongo_members_healthy ${members.filter(m => m.health === 1).length}\nchat_mongo_secondaries ${secondary.length}\nchat_mongo_replication_lag_observed ${primary && secondary.length ? 1 : 0}\n${primary && secondary.length ? `chat_mongo_replication_lag_seconds ${Math.max(0, ...secondary.map(m => (primary - m.optimeDate!.getTime()) / 1000))}\n` : ''}`;
        } catch { return 'chat_mongo_replication_observed 0\nchat_mongo_replication_lag_observed 0\n'; }
      }),
      this.inspect('redis', async () => {
        // AUTH/HELLO and client metadata commands share this bounded queue during connect.
        const redis = createClient({ url: c.REDIS_URL, disableOfflineQueue: true, commandsQueueMaxLength: 8, socket: { connectTimeout: timeout, reconnectStrategy: false } }); redis.on('error', () => {});
        const deadline = setTimeout(() => { if (redis.isOpen) redis.destroy(); }, timeout);
        try { await redis.connect(); if (await redis.withCommandOptions({ timeout }).ping() !== 'PONG') throw new Error('PING failed'); return ''; } finally { clearTimeout(deadline); if (redis.isOpen) redis.destroy(); }
      }),
      this.inspect('rabbitmq', async () => {
        const controller = new AbortController(), deadline = setTimeout(() => controller.abort(), timeout);
        try { const socketOptions = { timeout, signal: controller.signal }; const connection = await amqpConnect(c.RABBITMQ_URL, socketOptions); connection.on('error', () => {}); await connection.close(); return ''; }
        finally { clearTimeout(deadline); controller.abort(); }
      }),
      this.inspect('storage', async () => { await Promise.all([c.S3_QUARANTINE_BUCKET, c.S3_APPROVED_BUCKET].map(Bucket => this.storage.send(new HeadBucketCommand({ Bucket }), { abortSignal: AbortSignal.timeout(timeout) }))); return ''; }),
      this.inspect('scanner', async () => { await protocolProbe(c.CLAMAV_HOST, c.CLAMAV_PORT, timeout, 'scanner'); return ''; }),
      this.inspect('image', async () => { const text = await boundedText(new URL('/health/ready', c.IMAGE_PROCESSOR_URL), timeout, 4096); if (text.trim() !== 'ready') throw new Error('Processor unavailable'); return ''; }),
      this.inspect('livekit', async () => { await this.media.listRooms(['__commonroom_health_probe__']); return ''; }),
      this.inspect('smtp', async () => { await protocolProbe(c.SMTP_HOST, c.SMTP_PORT, timeout, 'smtp', c.SMTP_SECURE); return ''; })
    ]);
    let output = `chat_inspection_timestamp_seconds ${Date.now() / 1000}\nchat_push_provider_observed 0\n`;
    for (const name of dependencies) {
      const state = this.states[name];
      for (const [key, value] of Object.entries({ enabled: Number(state.enabled), observed: Number(state.observed), up: Number(state.up), last_probe_timestamp_seconds: state.last / 1000, failures: state.failures, backoff_seconds: Math.max(0, (state.next - Date.now()) / 1000) })) output += `chat_dependency_${key}{dependency="${name}"} ${value}\n`;
      output += state.details;
    }
    output += await this.inventory().catch(() => 'chat_inventory_observed 0\n');
    output += await this.brokerQueues().catch(() => 'chat_broker_queue_metrics_observed 0\n');
    if (c.OPERATIONS_MEDIA_METRICS && c.CALLS_ENABLED) {
      try { output += `chat_media_metrics_up 1\n${aggregateMediaMetrics(await boundedText(c.LIVEKIT_METRICS_URL, timeout))}`; }
      catch { output += 'chat_media_metrics_up 0\n'; }
    } else output += 'chat_media_metrics_enabled 0\n';
    return output;
  }
  private async inventory() {
    if (!this.states.mongodb.up) return 'chat_inventory_observed 0\n';
    const db = this.mongo.db(this.config.MONGODB_DATABASE), timeout = this.config.OPERATIONS_PROBE_TIMEOUT_MS;
    if (!await db.collection<{ _id: string }>('schemaMigrations').findOne({ _id: '008_operations' }, { timeoutMS: timeout })) return 'chat_inventory_observed 0\n';
    // Two monitor pool slots and finite collection/label catalog; no identifiers exported.
    const deadline = Date.now() + 4000;
    let text = 'chat_inventory_observed 1\n';
    for (const [queue, collection, field, pending, failed] of queues) {
      if (Date.now() >= deadline) throw new Error('Inventory budget');
      const rows = db.collection(collection), filter = { [field]: { $in: [...pending] } }, options = { maxTimeMS: timeout, timeoutMS: timeout };
      const count = await rows.countDocuments(filter, { ...options, limit: 1000001 });
      const oldest = await rows.findOne(filter, { ...options, sort: { createdAt: 1 }, projection: { createdAt: 1 } });
      text += `chat_durable_pending{queue="${queue}"} ${count}\nchat_durable_count_saturated{queue="${queue}"} ${count >= 1000001 ? 1 : 0}\nchat_durable_oldest_age_seconds{queue="${queue}"} ${oldest?.['createdAt'] instanceof Date ? Math.max(0, (Date.now() - oldest['createdAt'].getTime()) / 1000) : 0}\nchat_durable_failed{queue="${queue}"} ${failed.length ? await rows.countDocuments({ [field]: { $in: [...failed] } }, { ...options, limit: 1000001 }) : 0}\n`;
    }
    if (Date.now() >= deadline) throw new Error('Inventory budget');
    const totals = await db.collection('attachments').aggregate<{ _id: null; bytes: number; count: number }>([{ $match: { state: 'ready' } }, { $group: { _id: null, bytes: { $sum: '$approvedSize' }, count: { $sum: 1 } } }], { maxTimeMS: timeout, timeoutMS: timeout }).next();
    const call = await db.collection('callParticipants').countDocuments({ state: 'accepted' }, { maxTimeMS: timeout, timeoutMS: timeout, limit: 120001 });
    text += `chat_approved_attachment_bytes ${totals?.bytes ?? 0}\nchat_approved_attachment_objects ${totals?.count ?? 0}\nchat_accepted_call_participants ${call}\nchat_open_call_records ${await db.collection('calls').countDocuments({ open: true }, { maxTimeMS: timeout, timeoutMS: timeout, limit: 10001 })}\n`;
    return text;
  }
  private async brokerQueues() {
    const c = this.config, url = new URL(c.RABBITMQ_URL), vhost = decodeURIComponent(url.pathname.slice(1) || '/');
    const headers = { Authorization: `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString('base64')}` };
    const text = 'chat_broker_queue_metrics_observed 1\n';
    const results = await Promise.all(['fanout', 'notification'].flatMap(subscription => [false, true].map(async dead => {
      let text = '';
      const name = `${c.BROKER_NAMESPACE}.${c.MONGODB_DATABASE}.${subscription}${dead ? '.dead' : ''}`, label = `${subscription}${dead ? '_dead' : ''}`;
      const target = new URL(`/api/queues/${encodeURIComponent(vhost)}/${encodeURIComponent(name)}`, c.RABBITMQ_MANAGEMENT_URL);
      target.searchParams.set('columns', 'messages_ready,messages_unacknowledged,consumers,state,head_message_timestamp');
      try {
        const data = JSON.parse(await boundedText(target, c.OPERATIONS_PROBE_TIMEOUT_MS, 16384, headers)) as Record<string, unknown>;
        text += `chat_broker_queue_observed{queue="${label}"} 1\n`;
        for (const [field, metric] of [['messages_ready', 'ready'], ['messages_unacknowledged', 'unacknowledged'], ['consumers', 'consumers']] as const) {
          const value = data[field]; if (typeof value === 'number' && Number.isFinite(value) && value >= 0) text += `chat_broker_queue_${metric}{queue="${label}"} ${value}\n`;
        }
        const head = data['head_message_timestamp'];
        text += `chat_broker_oldest_age_observed{queue="${label}"} ${typeof head === 'number' && head > 0 ? 1 : 0}\n${typeof head === 'number' && head > 0 ? `chat_broker_oldest_age_seconds{queue="${label}"} ${Math.max(0, Date.now() / 1000 - head)}\n` : ''}`;
      } catch { text += `chat_broker_queue_observed{queue="${label}"} 0\n`; }
      return text;
    })));
    return text + results.join('');
  }
  async close() { await this.running; this.storage.destroy(); await this.mongo.close(); }
}
