import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, writeFile, unlink } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { finished } from 'node:stream/promises';
import { freemem } from 'node:os';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { argumentsFor, assertLocalTargets, budget } from '../tests/load/policy.js';
import { upgradeMediaFixture } from '../tests/integration/upgrade-media.js';
import { cleanupFixture } from '../tests/e2e/lifecycle.js';
import { assertLoadListenersStopped, cleanLoadEphemeral } from '../tests/load/cleanup.js';
const execute = promisify(execFile);
const selected = argumentsFor(process.argv.slice(2)); assertLocalTargets(process.env);
if (freemem() < budget.preflightFreeBytes) throw new Error('Load preflight requires 1.5 GiB free host memory');
if (await realpath('.cache') !== resolve('.cache')) throw new Error('Load cache cannot redirect');
const runId = randomUUID(), database = `chat_e2e_auth_${randomUUID().replaceAll('-', '')}`, directory = resolve('.cache', `load-${runId}`), lockPath = resolve('.cache/load.lock');
const lock = await open(lockPath, 'wx', 0o600);
let fixture: Awaited<ReturnType<typeof upgradeMediaFixture>> | undefined;
const outcome: Record<string, unknown> = { ...selected, applicationFixtureCleanup: 'not-completed', providerCleanup: 'not-completed' };
try {
  await lock.writeFile(JSON.stringify({ runId, pid: process.pid })); await mkdir(directory, { mode: 0o700 });
  await writeFile(resolve(directory, 'private-identity.json'), JSON.stringify({ runId, database, pid: process.pid }), { mode: 0o600 });
  console.info('Load report directory:', directory);
  fixture = await upgradeMediaFixture();
  await writeFile(resolve(directory, 'private-identity.json'), JSON.stringify({ runId, database, pid: process.pid, mediaName: fixture.env.UPGRADE_MEDIA_NAME, mediaOwner: fixture.env.UPGRADE_MEDIA_OWNER }), { mode: 0o600 });
  const names = ['commonroom-local-mongo-1', 'commonroom-local-redis-1', 'commonroom-local-rabbitmq-1', 'commonroom-local-garage-1', fixture.env.UPGRADE_MEDIA_NAME];
  const images = (await execute('docker', ['--config', '.cache/docker', 'inspect', '--format', '{{json .Config.Image}}', ...names], { windowsHide: true, timeout: 10000, maxBuffer: 32768 })).stdout.trim().split(/\r?\n/).map(line => JSON.parse(line) as string);
  const engine = JSON.parse((await execute('docker', ['--config', '.cache/docker', 'info', '--format', '{{json .}}'], { windowsHide: true, timeout: 10000, maxBuffer: 1048576 })).stdout) as { ServerVersion: string; NCPU: number; MemTotal: number };
  const workspace = JSON.parse(await readFile('package.json', 'utf8')) as { packageManager: string; devDependencies: Record<string, string> };
  const web = JSON.parse(await readFile('apps/web/package.json', 'utf8')) as { dependencies: Record<string, string> };
  await writeFile(resolve(directory, 'inventory.json'), JSON.stringify({ docker: { version: engine.ServerVersion, cpus: engine.NCPU, memoryBytes: engine.MemTotal }, imagePinsInRoleOrder: { roles: ['mongo', 'redis', 'rabbitmq', 'garage', 'owned-sfu'], images }, packageManager: workspace.packageManager, playwright: workspace.devDependencies['@playwright/test'], livekitClient: web.dependencies['livekit-client'], sourceCommit: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(), trackedChanges: !!(await execute('git', ['status', '--porcelain', '--untracked-files=no'])).stdout.trim() }), { mode: 0o600 });
  const env = { ...process.env, ...fixture.env, NODE_ENV: 'test', HOST: '127.0.0.1', API_PORT: '3000', GATEWAY_PORT: '3001', WORKER_PORT: '3002', WEB_ORIGIN: 'http://localhost:5173', E2E_DATABASE: database, E2E_RUN_ID: runId, LOAD_MODE: selected.mode, LOAD_PROFILE: selected.profile, LOAD_DIRECTORY: directory, LOG_LEVEL: 'error', NODE_OPTIONS: '--max-old-space-size=512' };
  const output = createWriteStream(resolve(directory, 'private.log'), { flags: 'wx', mode: 0o600 });
  const child = spawn(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test', '--config', 'tests/load/load.config.ts'], { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'], env });
  let bytes = 0, limitHit = false;
  const stop = () => {
    if (limitHit || !child.pid) return; limitHit = true;
    if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* exited */ } }
  };
  const timer = setTimeout(stop, budget.outerMs);
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk: Buffer) => {
    const allowed = Math.max(0, budget.logBytes - bytes), part = chunk.subarray(0, allowed); bytes += part.length;
    if (!output.write(part)) { stream.pause(); output.once('drain', () => stream.resume()); }
    if (chunk.length > allowed) stop();
  });
  const code = await new Promise<number>(done => { child.once('error', () => done(1)); child.once('close', code => done(code ?? 1)); });
  clearTimeout(timer); output.end(); await finished(output);
  Object.assign(outcome, { code, limitHit, logBytes: bytes });
  // Retry no operations automatically. This idempotent post-process cleanup is
  // also needed if the CLI died before its reporter could finish.
  Object.assign(process.env, fixture.env);
  await assertLoadListenersStopped();
  await cleanupFixture({ database, runId });
  const redisKeysRemoved = await cleanLoadEphemeral(database);
  Object.assign(outcome, { applicationFixtureCleanup: 'passed', redisKeysRemoved });
  process.exitCode = limitHit ? 1 : code;
  console.info('Load command exit:', process.exitCode);
} finally {
  try { await fixture?.close(); outcome['providerCleanup'] = fixture ? 'passed' : 'not-created'; }
  finally {
    try { await writeFile(resolve(directory, 'runner.json'), JSON.stringify(outcome), { mode: 0o600 }); }
    finally { await lock.close(); await unlink(lockPath); }
  }
}
