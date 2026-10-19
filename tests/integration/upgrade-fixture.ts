import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
interface Packet { kind: string; id?: string; result?: unknown; error?: { status: number; code: string }; data?: Record<string, unknown>; modulePath?: string; commit?: string; domainSha256?: string }
export async function upgradeProcess(directory: string, database: string, overrides: NodeJS.ProcessEnv = {}) {
  if (!/^upgrade_test_[a-f0-9]{32}$/.test(database)) throw new Error('Upgrade process refuses ordinary or restored targets');
  const child = spawn(process.execPath, ['tests/fixtures/upgrade-process.mjs', resolve(directory)], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: { ...process.env, ...overrides, NODE_ENV: 'test', MONGODB_DATABASE: database, LOG_LEVEL: 'error' } });
  const diagnosticPath = `.cache/upgrade-child-${child.pid}.log`; let diagnostic = '';
  child.stderr?.on('data', bytes => { diagnostic = (diagnostic + String(bytes)).slice(-32768); });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  const barriers = new Map<string, (data: Record<string, unknown>) => void>();
  let readyResolve!: (packet: Packet) => void, readyReject!: (error: Error) => void;
  const ready = new Promise<Packet>((done, reject) => { readyResolve = done; readyReject = reject; });
  const exit = new Promise<void>(done => child.once('exit', () => { void writeFile(diagnosticPath, diagnostic); readyReject(new Error(`Upgrade child exited before ready; inspect ${diagnosticPath}`)); for (const row of pending.values()) { clearTimeout(row.timer); row.reject(new Error('Upgrade child exited')); } pending.clear(); done(); }));
  child.on('error', () => readyReject(new Error('Upgrade child failed to launch')));
  child.on('message', (message: Packet) => {
    if (message.kind === 'ready') readyResolve(message);
    else if (message.kind === 'barrier' && message.id) { barriers.get(message.id)?.(message.data!); barriers.delete(message.id); }
    else if (message.kind === 'result' && message.id) { const row = pending.get(message.id); if (row) { clearTimeout(row.timer); pending.delete(message.id); if (message.error) row.reject(message.error); else row.resolve(message.result); } }
  });
  const request = <T>(op: string, data: Record<string, unknown> = {}, id = randomUUID()) => new Promise<T>((done, reject) => {
    if (!child.connected) { reject(new Error('Upgrade child disconnected')); return; }
    const timer = setTimeout(() => { pending.delete(id); barriers.delete(id); reject(new Error('Upgrade operation deadline')); }, 100000);
    pending.set(id, { resolve: value => done(value as T), reject, timer }); child.send({ id, op, data });
  });
  const terminate = async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exit; };
  const deadline = setTimeout(() => readyReject(new Error('Upgrade child startup deadline')), 45000);
  let identity: Packet;
  try { identity = await ready; } catch (error) { await terminate(); throw error; } finally { clearTimeout(deadline); }
  return { identity, request,
    async hold(op: string) { const id = randomUUID(); const barrier = new Promise<Record<string, unknown>>(done => barriers.set(id, done)); const completed = request(op, {}, id); void completed.catch(() => {}); return { data: await Promise.race([barrier, completed.then(() => { throw new Error('Missing upgrade barrier'); })]), completed }; },
    release() { child.send({ op: 'release' }); },
    terminate,
    async close() { if (child.connected) { const fallback = setTimeout(() => child.kill('SIGKILL'), 10000); try { await request('close'); await exit; } catch { await terminate(); } finally { clearTimeout(fallback); } } else await terminate(); }
  };
}
