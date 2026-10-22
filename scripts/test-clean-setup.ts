import { execFile, spawn } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { copyFile, lstat, mkdir, open, readFile, realpath, statfs, unlink, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { freemem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { addSetupScanner, assertSetupLabels, setupCompose, setupIdentity, setupServices, setupVolumes, sourcePath } from './clean-setup-policy.js';
import type { upgradeMediaFixture as MediaFixture } from '../tests/integration/upgrade-media.js';

// Source snapshot, not a clone or clean-machine claim. The original checkout,
// running services and volumes are never used as rehearsal targets.
const full = process.argv[2] === 'full';
if (process.argv.length !== (full ? 3 : 2) || process.env['NODE_ENV'] === 'production') throw new Error('Use test:setup:clean [full] in a local workspace');
const root = await realpath('.');
if (root !== resolve('.') || await realpath('.cache') !== resolve('.cache')) throw new Error('Setup workspace/cache cannot redirect');
const disk = await statfs(root);
const requiredFree = (full ? 4096 : 2560) * 1024 ** 2;
if (freemem() < requiredFree || disk.bavail * disk.bsize < (full ? 5 : 3) * 1024 ** 3) throw new Error(`Setup rehearsal requires ${full ? '4 GiB free host RAM and 5' : '2.5 GiB free host RAM and 3'} GiB disk`);
const execute = promisify(execFile), owner = randomUUID().replaceAll('-', ''), { project, database } = setupIdentity(owner);
const directory = resolve('.cache', `clean-setup-${owner}`), checkout = resolve(directory, 'source'), dockerConfig = resolve('.cache/docker');
const pnpm = resolve('.cache/pnpm-cli/node_modules/pnpm/bin/pnpm.mjs');
await lstat(pnpm);
const lockPath = resolve('.cache/clean-setup.lock'), lock = await open(lockPath, 'wx', 0o600);
const outcome: { scope: string; passed: boolean; cleanup: string; providerCleanup?: string; steps: { name: string; seconds: number; passed: boolean }[] } = { scope: full ? 'fresh-source-full-stack-and-journey' : 'fresh-source-and-baseline-only', passed: false, cleanup: 'not-completed', steps: [] };
let media: Awaited<ReturnType<typeof MediaFixture>> | undefined;
const docker = async (args: string[], timeout = 15000) => execute('docker', ['--config', dockerConfig, ...args], { windowsHide: true, timeout, maxBuffer: 1048576 });
const env: NodeJS.ProcessEnv = { ...process.env };
async function step(name: string, executable: string, args: string[], cwd = checkout, timeout = 180000) {
  console.info('Setup step:', name);
  const start = Date.now(), output = createWriteStream(resolve(directory, `${name}.log`), { flags: 'wx', mode: 0o600 });
  const child = spawn(executable, args, { cwd, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0, limitHit = false;
  const stop = () => {
    if (limitHit || !child.pid) return; limitHit = true;
    if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* exited */ } }
  };
  const timer = setTimeout(stop, timeout);
  const memory = setInterval(() => { if (freemem() < 512 * 1024 ** 2) stop(); }, 2000);
  for (const input of [child.stdout, child.stderr]) input.on('data', (chunk: Buffer) => {
    const allowed = Math.max(0, 8 * 1048576 - bytes), part = chunk.subarray(0, allowed); bytes += part.length;
    if (!output.write(part)) { input.pause(); output.once('drain', () => input.resume()); }
    if (chunk.length > allowed) stop();
  });
  const code = await new Promise<number>(done => { child.once('error', () => done(1)); child.once('close', value => done(value ?? 1)); });
  clearTimeout(timer); clearInterval(memory); output.end(); await finished(output);
  outcome.steps.push({ name, seconds: (Date.now() - start) / 1000, passed: code === 0 && !limitHit });
  await writeFile(resolve(directory, 'outcome.json'), JSON.stringify(outcome), { mode: 0o600 });
  if (code !== 0 || limitHit) throw new Error(`Setup step failed: ${name}; inspect private log`);
}
const node = (name: string, args: string[]) => step(name, process.execPath, args);
const packageCommand = (name: string, args: string[]) => node(name, [pnpm, ...args]);
const file = resolve(directory, 'compose.json'), compose = ['--config', dockerConfig, 'compose', '-p', project, '-f', file];
async function cleanup() {
  // Inspect all resources first. A forged/foreign resource aborts deletion.
  const inventory: { kind: string; name: string }[] = [];
  for (const kind of ['container', 'volume', 'network']) {
    const args = kind === 'container' ? ['ps', '-aq'] : [kind, 'ls', '-q'];
    const names = (await docker([...args, '--filter', `label=com.docker.compose.project=${project}`])).stdout.trim().split(/\s+/).filter(Boolean);
    if (names.length > 12) throw new Error('Unexpected setup cleanup inventory');
    for (const name of names) {
      const value = JSON.parse((await docker([kind, 'inspect', name])).stdout) as { Name: string; Config?: { Labels: Record<string, string> }; Labels?: Record<string, string> }[];
      if (value.length !== 1) throw new Error('Unexpected setup resource inspection');
      assertSetupLabels(kind === 'container' ? value[0]!.Config?.Labels ?? null : value[0]!.Labels ?? null, owner, project);
      const actual = value[0]!.Name.replace(/^\//, '');
      const allowed = kind === 'container' ? [...setupServices, ...(full ? ['clamav', 'image-processor', 'image-proxy'] : [])].map(service => `${project}-${service}-1`) : kind === 'volume' ? [...setupVolumes, ...(full ? ['clamav-data'] : [])].map(volume => `${project}_${volume}`) : ['default', ...(full ? ['scanning', 'processing'] : [])].map(network => `${project}_${network}`);
      if (!allowed.includes(actual)) throw new Error('Unexpected owned setup resource name');
      inventory.push({ kind, name });
    }
  }
  for (const kind of ['container', 'volume', 'network']) for (const resource of inventory.filter(row => row.kind === kind)) await docker([kind, 'rm', ...(kind === 'container' ? ['-f'] : []), resource.name], 30000);
  if (full) {
    const image = `${project}-processor:0.0.0`, inspected = await docker(['image', 'inspect', '--format', '{{json .Config.Labels}}', image]).catch(error => {
      if (/No such (image|object)/i.test(String((error as { stderr?: string }).stderr))) return null; throw error;
    });
    if (inspected) { assertSetupLabels(JSON.parse(inspected.stdout) as Record<string, string>, owner, project); await docker(['image', 'rm', image]); }
  }
  for (const kind of ['container', 'volume', 'network']) {
    const args = kind === 'container' ? ['ps', '-aq'] : [kind, 'ls', '-q'];
    if ((await docker([...args, '--filter', `label=com.docker.compose.project=${project}`])).stdout.trim()) throw new Error('Setup resources remain');
  }
  outcome.cleanup = 'passed';
}
try {
  await lock.writeFile(JSON.stringify({ owner, project, pid: process.pid })); await mkdir(checkout, { recursive: true });
  console.info('Private setup evidence:', directory);
  const totalMemory = Number((await docker(['info', '--format', '{{.MemTotal}}'])).stdout.trim());
  if (totalMemory < (full ? 7 : 6) * 1024 ** 3) throw new Error(`Setup rehearsal requires a Docker VM with at least ${full ? 7 : 6} GiB configured`);
  const files = [...new Set((await execute('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { maxBuffer: 1048576 })).stdout.split('\0').filter(Boolean))].sort();
  if (!files.length || files.length > 2000) throw new Error('Unexpected setup source inventory');
  const manifest: { path: string; sha256: string }[] = [];
  for (const name of files) {
    const source = sourcePath(root, name), target = sourcePath(checkout, name), stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1048576 || await realpath(source) !== source) throw new Error('Setup source must be bounded regular files without redirects');
    const before = await readFile(source);
    await mkdir(dirname(target), { recursive: true }); await copyFile(source, target);
    const copied = await readFile(target);
    if (!before.equals(copied)) throw new Error('Source changed during setup snapshot');
    manifest.push({ path: name, sha256: createHash('sha256').update(copied).digest('hex') });
  }
  const commit = (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim();
  await writeFile(resolve(directory, 'source-manifest.json'), JSON.stringify({ commit, node: process.version, warmToolchainAndPackageCache: true, files: manifest }), { mode: 0o600 });
  await mkdir(resolve(checkout, '.cache'));
  // Avoid inherited service/production overrides; copy no .env into the snapshot.
  for (const match of (await readFile('.env.example', 'utf8')).matchAll(/^([A-Z][A-Z0-9_]*)=/gm)) delete env[match[1]!];
  Object.assign(env, { NODE_ENV: 'development', NODE_OPTIONS: '--max-old-space-size=512', PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env['PATH'] ?? ''}` });
  await packageCommand('install', ['install', '--frozen-lockfile', '--store-dir', resolve('.pnpm-store'), `--config.cacheDir=${resolve('.cache/pnpm')}`, '--state-dir', resolve(checkout, '.cache/pnpm-state')]);
  await packageCommand('build', ['build']);
  const locked = await readFile(resolve(checkout, 'pnpm-lock.yaml'));
  if (createHash('sha256').update(locked).digest('hex') !== manifest.find(row => row.path === 'pnpm-lock.yaml')?.sha256) throw new Error('Frozen install changed lockfile');
  const ports: number[] = [];
  while (ports.length < (full ? 13 : 7)) {
    const listener = createServer(); await new Promise<void>(done => listener.listen(0, '127.0.0.1', done));
    const address = listener.address(); if (!address || typeof address === 'string') throw new Error('No setup port');
    await new Promise<void>(done => listener.close(() => done())); if (!ports.includes(address.port)) ports.push(address.port);
  }
  const source = JSON.parse((await docker(['compose', '-f', resolve(checkout, 'infra/compose/compose.yaml'), '--profile', 'scanner', 'config', '--format', 'json'])).stdout) as Parameters<typeof setupCompose>[0];
  const baseline = setupCompose(source, owner, ports.slice(0, 7), resolve(checkout, 'infra/compose/garage.toml'));
  await writeFile(file, JSON.stringify(full ? addSetupScanner(baseline, source, owner, [ports[7]!, ports[8]!]) : baseline), { mode: 0o600 });
  const [mongo, redis, rabbit, management, storage, smtp, mail] = ports;
  Object.assign(env, { NODE_ENV: 'test', HOST: '127.0.0.1', SETUP_REHEARSAL_OWNER: owner, MONGODB_DATABASE: database,
    MONGODB_URI: `mongodb://127.0.0.1:${mongo}/${database}?replicaSet=rs0&directConnection=true`, REDIS_URL: `redis://:local-only-redis-password@127.0.0.1:${redis}`,
    RABBITMQ_URL: `amqp://chat:local-only-rabbit-password@127.0.0.1:${rabbit}/chat`, RABBITMQ_MANAGEMENT_URL: `http://127.0.0.1:${management}`,
    S3_ENDPOINT: `http://127.0.0.1:${storage}`, SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp), MAILPIT_URL: `http://127.0.0.1:${mail}`, LOG_LEVEL: 'error' });
  if (freemem() < requiredFree) throw new Error('Insufficient free host RAM after source build; no services started');
  await step('start', 'docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '240', ...setupServices], root, 255000);
  await step('approved-bucket', 'docker', [...compose, 'exec', '-T', 'garage', '/garage', 'bucket', 'create', 'chat-approved'], root);
  await step('approved-grant', 'docker', [...compose, 'exec', '-T', 'garage', '/garage', 'bucket', 'allow', '--read', '--write', '--owner', 'chat-approved', '--key', 'GK00000000000000000000000000000001'], root);
  await packageCommand('cors', ['attachments:configure']);
  await packageCommand('foundation', ['test:integration:foundation']);
  await packageCommand('migrate', ['db:migrate']);
  await node('markers-capture', ['node_modules/tsx/dist/cli.mjs', 'scripts/verify-clean-setup.ts', 'capture']);
  await packageCommand('migrate-again', ['db:migrate']);
  await node('markers-idempotent', ['node_modules/tsx/dist/cli.mjs', 'scripts/verify-clean-setup.ts', 'verify']);
  await packageCommand('auth', ['test:integration:auth']);
  await step('restart', 'docker', [...compose, 'restart', 'mongo'], root, 30000);
  await step('restart-ready', 'docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '120', ...setupServices], root, 135000);
  await node('markers-retained', ['node_modules/tsx/dist/cli.mjs', 'scripts/verify-clean-setup.ts', 'verify']);
  if (full) {
    Object.assign(env, { PLAYWRIGHT_BROWSERS_PATH: resolve(checkout, '.cache/ms-playwright'), CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(ports[7]), IMAGE_PROCESSOR_URL: `http://127.0.0.1:${ports[8]}`,
      E2E_SETUP_PORTS: ports.slice(9).join(','), API_PORT: String(ports[9]), GATEWAY_PORT: String(ports[10]), WORKER_PORT: String(ports[11]), WEB_DEV_PORT: String(ports[12]), WEB_ORIGIN: `http://localhost:${ports[12]}` });
    await packageCommand('docker-config', ['infra:config']);
    await packageCommand('browser-install', ['exec', 'playwright', 'install', 'chromium']);
    await step('processor-build', 'docker', [...compose, 'build', 'image-processor'], root, 240000);
    await step('scanner-start', 'docker', [...compose, 'up', '-d', '--wait', '--wait-timeout', '900', 'clamav', 'image-processor', 'image-proxy'], root, 915000);
    const { upgradeMediaFixture } = await import('../tests/integration/upgrade-media.js');
    media = await upgradeMediaFixture({ webhookPort: ports[9]! }); Object.assign(env, media.env);
    await step('fresh-journey', process.execPath, ['node_modules/@playwright/test/cli.js', 'test', '--config', 'tests/e2e/journey.config.ts'], checkout, 540000);
  }
  outcome.passed = true;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Setup rehearsal failed'); process.exitCode = 1;
} finally {
  try { await media?.close(); outcome.providerCleanup = media ? 'passed' : 'not-created'; } catch { outcome.providerCleanup = 'failed'; outcome.passed = false; process.exitCode = 1; }
  try { await cleanup(); } catch { outcome.cleanup = 'failed-inspect-owned-resources'; outcome.passed = false; process.exitCode = 1; }
  try { await writeFile(resolve(directory, 'outcome.json'), JSON.stringify(outcome), { mode: 0o600 }); console.info(JSON.stringify(outcome)); }
  finally { await lock.close(); await unlink(lockPath); }
}
