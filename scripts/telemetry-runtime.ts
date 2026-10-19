import { resolve, relative, isAbsolute } from 'node:path';
import { mkdir, open, rename, realpath, unlink } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '@chat/config';
import { OperationsMonitor, boundedText } from '@chat/domain';
export const roles = ['api', 'gateway', 'worker', 'ops'] as const;
export type SnapshotRole = typeof roles[number];
export async function telemetryDirectory(input = process.env['TELEMETRY_RUNTIME_DIR'] ?? 'infra/compose/.runtime/telemetry') {
  const root = await realpath('.'), target = resolve(input), rel = relative(root, target).replaceAll('\\', '/');
  if (isAbsolute(rel) || !(rel.startsWith('.cache/') || rel.startsWith('infra/compose/.runtime/'))) throw new Error('Telemetry state must be inside ignored workspace storage');
  await mkdir(target, { recursive: true });
  const actual = await realpath(target), actualRel = relative(root, actual).replaceAll('\\', '/');
  if (isAbsolute(actualRel) || actualRel.startsWith('../') || actualRel !== rel) throw new Error('Telemetry state cannot redirect outside its workspace target');
  await mkdir(resolve(actual, 'snapshots'), { recursive: true });
  return actual;
}
export async function writeSnapshot(directory: string, role: SnapshotRole, metrics: string, state = { up: true, live: true, ready: true }) {
  if (!roles.includes(role) || Buffer.byteLength(metrics) > 524288) throw new Error('Snapshot limit');
  const target = resolve(directory, 'snapshots', `${role}.json`), temporary = resolve(directory, 'snapshots', `${role}.${process.pid}.tmp`);
  const handle = await open(temporary, 'w', 0o644);
  try { await handle.writeFile(JSON.stringify({ v: 1, role, observedAt: Date.now(), metrics, ...state })); } finally { await handle.close(); }
  // Windows bind mounts/antivirus may briefly hold the previous snapshot open.
  // Keep replacement atomic, retry only sharing errors, and bound the wait.
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, target); break; }
      catch (error) {
        if (attempt === 9 || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        await delay(50);
      }
    }
  } finally { await unlink(temporary).catch(() => {}); }
}
export function assertLocalInspection(config: Config) {
  const loopback = (host: string) => ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host);
  if (config.NODE_ENV === 'production' || !loopback(config.HOST) || !loopback(config.SMTP_HOST) || !loopback(config.CLAMAV_HOST)) throw new Error('This host snapshot agent is local-only');
  for (const value of [config.MONGODB_URI, config.REDIS_URL, config.RABBITMQ_URL, config.RABBITMQ_MANAGEMENT_URL, config.S3_ENDPOINT, config.IMAGE_PROCESSOR_URL, config.LIVEKIT_API_URL, config.LIVEKIT_METRICS_URL]) if (!loopback(new URL(value).hostname)) throw new Error('This host snapshot agent only inspects loopback dependencies');
}
export async function captureRole(config: Config, role: Exclude<SnapshotRole, 'ops'>) {
  const port = role === 'api' ? config.API_PORT : role === 'gateway' ? config.GATEWAY_PORT : config.WORKER_PORT;
  const host = config.HOST === '::1' ? '[::1]' : config.HOST, base = `http://${host}:${port}`, timeout = config.OPERATIONS_PROBE_TIMEOUT_MS;
  const status = async (path: string) => { try { const response = await fetch(base + path, { signal: AbortSignal.timeout(timeout), redirect: 'error' }); await response.body?.cancel(); return response.status === 200; } catch { return false; } };
  const [metrics, live, ready] = await Promise.all([boundedText(base + '/metrics', timeout, 524288).catch(() => null), status('/health/live'), status('/health/ready')]);
  if (metrics !== null && metrics.split('\n').some(line => line && !line.startsWith('#') && !/^[a-zA-Z_:][\w:]*(?:\{[^\n]*\})?\s+(?:[\d.eE+-]+|[+-]?Inf|NaN)(?:\s+\d+)?$/.test(line))) return { metrics: '', up: false, live, ready };
  return { metrics: metrics ?? '', up: metrics !== null, live, ready };
}
export async function snapshotAgent(config: Config, directory: string, signal: AbortSignal) {
  assertLocalInspection(config);
  const lockPath = resolve(directory, 'agent.lock'), lock = await open(lockPath, 'wx', 0o600);
  await lock.writeFile(String(process.pid));
  const monitor = new OperationsMonitor(config);
  try {
    while (!signal.aborted) {
      await Promise.all([
        ...(['api', 'gateway', 'worker'] as const).map(async role => { const state = await captureRole(config, role); await writeSnapshot(directory, role, state.metrics, state); }),
        monitor.tick().then(metrics => writeSnapshot(directory, 'ops', metrics))
      ]);
      await new Promise<void>(done => {
        if (signal.aborted) { done(); return; }
        const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); done(); };
        const timer = setTimeout(stop, config.OPERATIONS_INTERVAL_MS); signal.addEventListener('abort', stop, { once: true });
      });
    }
  } finally { await monitor.close(); await lock.close(); await unlink(lockPath); }
}
