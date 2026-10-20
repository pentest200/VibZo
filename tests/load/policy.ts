export const profiles = {
  small: { chatUsers: 4, groups: 1, rate: 2, payloadBytes: 256, mediaUsers: 2 },
  moderate: { chatUsers: 8, groups: 2, rate: 4, payloadBytes: 1024, mediaUsers: 3 },
  step: { chatUsers: 8, groups: 2, rate: 8, payloadBytes: 1024, mediaUsers: 3 },
} as const;
export type Profile = keyof typeof profiles;
export type Mode = 'chat' | 'media' | 'combined';
export const budget = { warmupMs: 4000, measuredMs: 12000, maxInflight: 4, maxSamples: 90, reportBytes: 524288, logBytes: 8388608, outerMs: 480000, minFreeBytes: 512 * 1024 ** 2, preflightFreeBytes: 1536 * 1024 ** 2, generatorRss: 768 * 1024 ** 2, appRss: 512 * 1024 ** 2, maxBacklog: 512 } as const;
export function argumentsFor(args: string[]): { mode: Mode; profile: Profile } {
  const [mode, profile = 'small'] = args;
  if (args.length > 2 || !['chat', 'media', 'combined'].includes(mode ?? '') || !Object.hasOwn(profiles, profile)) throw new Error('Usage: load <chat|media|combined> [small|moderate|step]');
  return { mode: mode as Mode, profile: profile as Profile };
}
export function assertLocalTargets(env: NodeJS.ProcessEnv) {
  if (env['NODE_ENV'] === 'production') throw new Error('Load generation refuses production');
  for (const name of ['MONGODB_URI', 'REDIS_URL', 'RABBITMQ_URL', 'S3_ENDPOINT', 'IMAGE_PROCESSOR_URL', 'LIVEKIT_URL', 'LIVEKIT_API_URL']) {
    const value = env[name]; if (!value) continue;
    const url = new URL(value);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) || !['mongodb:', 'redis:', 'amqp:', 'http:', 'ws:'].includes(url.protocol)) throw new Error(`Load generation requires a local ${name}`);
  }
  if (env['HOST'] && env['HOST'] !== '127.0.0.1' || env['SMTP_HOST'] && env['SMTP_HOST'] !== '127.0.0.1' || env['CLAMAV_HOST'] && env['CLAMAV_HOST'] !== '127.0.0.1') throw new Error('Load listeners/dependencies must be loopback');
  if (env['WEB_ORIGIN'] && env['WEB_ORIGIN'] !== 'http://localhost:5173') throw new Error('Load origin is fixed');
}
export function distribution(values: number[]) {
  if (values.some(value => !Number.isFinite(value) || value < 0)) throw new Error('Invalid measurement');
  const sorted = [...values].sort((a, b) => a - b), at = (p: number) => sorted.length ? sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)]! : null;
  return { count: sorted.length, min: sorted[0] ?? null, p50: at(.5), p95: at(.95), p99: at(.99), max: sorted.at(-1) ?? null };
}
const names = new Set(['chat_process_resident_memory_bytes', 'chat_process_cpu_user_seconds_total', 'chat_process_cpu_system_seconds_total', 'chat_nodejs_eventloop_lag_p99_seconds', 'chat_outbox_pending', 'chat_outbox_oldest_age_seconds', 'chat_fanout_pending', 'chat_gateway_connections', 'chat_gateway_hint_queue', 'chat_gateway_pending_acks']);
export function numericMetrics(raw: string) {
  if (Buffer.byteLength(raw) > budget.reportBytes) throw new Error('Metrics response exceeds bound');
  const result: Record<string, number> = {};
  for (const line of raw.split('\n')) {
    const match = /^(\w+) ([\d.eE+-]+)$/.exec(line);
    if (match && names.has(match[1]!)) { const value = Number(match[2]); if (!Number.isFinite(value) || value < 0) throw new Error('Invalid metric'); result[match[1]!] = value; }
  }
  return result;
}
