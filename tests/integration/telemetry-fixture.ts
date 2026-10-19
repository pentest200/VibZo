import { createServer, connect } from 'node:net';
import type { Socket } from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { telemetryDirectory } from '../../scripts/telemetry-runtime.js';
import { waitFor } from './messaging-fixture.js';
const execute = promisify(execFile);
interface AlertRead { counts: Record<string, number>; history: { status: string; labels: Record<string, string>; receivedAt: number }[] }
export async function reservePort() {
  const server = createServer(); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test port missing');
  await new Promise<void>(done => server.close(() => done())); return address.port;
}
export async function faultProxy(host: string, port: number) {
  let blocked = false; const streams = new Set<Socket>();
  const server = createServer(incoming => {
    if (blocked) { incoming.destroy(); return; }
    const outgoing = connect(port, host);
    for (const socket of [incoming, outgoing]) { streams.add(socket); socket.on('error', () => {}); socket.on('close', () => streams.delete(socket)); }
    incoming.once('close', () => outgoing.destroy()); outgoing.once('close', () => incoming.destroy());
    incoming.pipe(outgoing); outgoing.pipe(incoming);
  });
  server.maxConnections = 64;
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Proxy port missing');
  return { port: address.port, setBlocked(value: boolean) { blocked = value; if (value) for (const stream of streams) stream.destroy(); }, async close() { for (const stream of streams) stream.destroy(); await new Promise<void>(done => server.close(() => done())); } };
}
export function through(url: string, port: number) { const target = new URL(url); target.hostname = '127.0.0.1'; target.port = String(port); return target.toString(); }
export async function telemetryFixture() {
  const id = randomUUID().replaceAll('-', '').slice(0, 12), project = `commonroom-telemetry-drill-${id}`;
  const directory = await telemetryDirectory(`.cache/telemetry-drill-${id}`);
  const [prometheusPort, alertmanagerPort, otlpPort] = await Promise.all([reservePort(), reservePort(), reservePort()]);
  const env = { ...process.env, TELEMETRY_RUNTIME_DIR: directory, TELEMETRY_PROMETHEUS_PORT: String(prometheusPort), TELEMETRY_ALERTMANAGER_PORT: String(alertmanagerPort), TELEMETRY_OTLP_PORT: String(otlpPort) };
  const base = ['--config', '.cache/docker', 'compose', '-p', project, '-f', 'infra/compose/compose.yaml', '--profile', 'telemetry'];
  const compose = async (args: string[]) => (await execute('docker', [...base, ...args], { env, windowsHide: true, timeout: 60000, maxBuffer: 1048576 })).stdout;
  const ids: Record<string, string> = {};
  let alertRead: Promise<AlertRead> | undefined;
  const endpoint = `http://127.0.0.1:${prometheusPort}`, otlp = `http://127.0.0.1:${otlpPort}/v1/traces`;
  const close = async () => { if (!/^commonroom-telemetry-drill-[a-f0-9]{12}$/.test(project)) throw new Error('Unsafe telemetry project'); await writeFile(resolve(directory, 'collector.log'), await compose(['logs', '--tail', '100', 'collector']).catch(() => 'Unavailable')); await compose(['down', '--remove-orphans', '--volumes']); };
  try {
    await compose(['up', '-d', '--no-build', 'telemetry-relay', 'collector', 'prometheus', 'alertmanager']);
    for (const role of ['telemetry-relay', 'collector', 'prometheus', 'alertmanager']) { ids[role] = (await compose(['ps', '-q', role])).trim(); if (!/^[a-f0-9]{64}$/.test(ids[role]!)) throw new Error('Telemetry container missing'); }
    await waitFor(async () => { try { return (await fetch(endpoint + '/-/ready')).ok; } catch { return false; } }, 20000);
  } catch (error) { const logs = await compose(['logs', '--tail', '20', 'prometheus', 'collector', 'alertmanager']).catch(() => 'Telemetry startup logs unavailable'); await writeFile(resolve(directory, 'startup.log'), logs); await close(); throw new Error(`Telemetry readiness failed; inspect ${directory}/startup.log`, { cause: error }); }
  return { directory, compose, ids, endpoint, otlp, close,
    async portBindings(role: string) { if (!ids[role]) throw new Error('Unknown test service'); return JSON.parse((await execute('docker', ['--config', '.cache/docker', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', ids[role]!], { windowsHide: true, timeout: 10000 })).stdout) as Record<string, { HostIp: string; HostPort: string }[]>; },
    async query(expression: string) { const response = await fetch(endpoint + '/api/v1/query?query=' + encodeURIComponent(expression), { signal: AbortSignal.timeout(3000) }); const data = await response.json() as { status: string; data: { result: { metric: Record<string, string>; value: [number, string] }[] } }; if (data.status !== 'success') throw new Error('Prometheus query failed'); return data.data.result; },
    alerts() {
      // Concurrent assertions share one bounded inspection process, respecting the relay PID cap.
      return alertRead ??= (async () => {
        try { return JSON.parse(await compose(['exec', '-T', 'telemetry-relay', 'node', '-e', "fetch('http://127.0.0.1:9465/alerts').then(r=>r.text()).then(s=>process.stdout.write(s))"])) as AlertRead; }
        finally { setTimeout(() => { alertRead = undefined; }, 250).unref(); }
      })();
    },
    async traces() { const path = resolve(directory, 'traces.json'); const bytes = await compose(['exec', '-T', 'telemetry-relay', 'node', '-e', "const f=require('node:fs');const p='/traces/traces.json';if(f.existsSync(p)){if(f.statSync(p).size>1048576)throw Error('Test trace limit');process.stdout.write(f.readFileSync(p,'utf8'))}"]); await writeFile(path, bytes); return readFile(path, 'utf8'); }
  };
}
export async function roleProcess(role: 'api' | 'gateway' | 'worker', env: NodeJS.ProcessEnv, port: number) {
  const child = spawn(process.execPath, ['tests/fixtures/drain-process.mjs', role], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: { ...process.env, ...env, [`${role.toUpperCase()}_PORT`]: String(port), NODE_ENV: 'test', LOG_LEVEL: 'error', DRAIN_DELAY_MS: '0' } });
  let diagnostic = '';
  for (const stream of [child.stdout, child.stderr]) stream?.on('data', chunk => { diagnostic = (diagnostic + String(chunk)).slice(-32768); });
  const exited = new Promise<number | null>(done => child.once('exit', code => done(code)));
  const url = `http://127.0.0.1:${port}`;
  const close = async () => {
    await writeFile(resolve('.cache', `telemetry-role-${role}-${port}.log`), diagnostic);
    if (child.exitCode !== null || child.signalCode !== null) return;
    if (process.platform === 'win32') child.send('test:terminate'); else child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill(), 15000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  try { await waitFor(async () => { if (child.exitCode !== null) throw new Error(`Test ${role} exited early`); try { return (await fetch(url + '/health/live', { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; } }, 25000); }
  catch (error) { await close(); const path = resolve('.cache', `telemetry-role-${role}-${port}.log`); await writeFile(path, diagnostic); throw new Error(`Test ${role} startup failed; inspect ${path}`, { cause: error }); }
  return { child, url, close, exited };
}
