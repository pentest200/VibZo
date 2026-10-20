import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

const configDirectory = resolve('.cache/docker');
mkdirSync(configDirectory, { recursive: true });
// Retain installed Docker Desktop plugin discovery without reading its credential file.
if (process.platform === 'win32') {
  const executableDirectory = (process.env['PATH'] ?? '').split(';').find(path => existsSync(join(path, 'docker.exe')));
  if (executableDirectory) {
    const plugins = join(dirname(executableDirectory), 'cli-plugins');
    if (existsSync(plugins)) writeFileSync(join(configDirectory, 'config.json'), JSON.stringify({ cliPluginsExtraDirs: [plugins] }));
  }
}
const base = ['--config', configDirectory, 'compose', '-f', 'infra/compose/compose.yaml'];
const execute = promisify(execFile);
async function diagnose() {
  // State/health only: never dump Config.Env or Docker's credential settings.
  // Inspection is bounded and must not mask the original startup failure.
  try {
    const result = await execute('docker', [...base, 'ps', '--all', '--quiet'], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
    const ids = result.stdout.trim().split(/\s+/).filter(Boolean);
    if (ids.length > 16 || ids.some(id => !/^[a-f0-9]{12,64}$/.test(id))) throw new Error('Unexpected Compose container inventory');
    for (const id of ids) {
      const state = await execute('docker', ['--config', configDirectory, 'inspect', '--format', '{{.Name}} {{json .State}}', id], { windowsHide: true, timeout: 5000, maxBuffer: 65536 });
      console.error(state.stdout.trim());
    }
  } catch { console.error('Container health inspection failed; inspect Docker/Compose and service logs directly.'); }
}
async function run(args: string[], allowFailure = false): Promise<boolean> {
  return new Promise<boolean>((success, fail) => {
    const child = spawn('docker', [...base, ...args], { stdio: 'inherit', shell: false });
    child.once('error', fail); child.once('exit', code => code === 0 ? success(true) : allowFailure ? success(false) : fail(new Error(`Docker Compose command failed (${code}); inspect service health/startup diagnostics above`)));
  });
}
async function start(args: string[]) {
  try { await run(args); } catch (error) { await diagnose(); throw error; }
}
const operation = process.argv[2];
if (!existsSync('infra/compose/compose.yaml')) throw new Error('Run from repository root');
switch (operation) {
  case 'config': await run(['--profile', 'media', '--profile', 'scanner', '--profile', 'telemetry', 'config', '--quiet']); break;
  case 'up':
    await start(['up', '-d', '--wait', '--wait-timeout', '240']);
    if (!await run(['exec', '-T', 'garage', '/garage', 'bucket', 'info', 'chat-approved'], true)) {
      await run(['exec', '-T', 'garage', '/garage', 'bucket', 'create', 'chat-approved']);
    }
    await run(['exec', '-T', 'garage', '/garage', 'bucket', 'allow', '--read', '--write', '--owner', 'chat-approved', '--key', 'GK00000000000000000000000000000001']);
    await import('./configure-attachments.js');
    break;
  case 'down': await run(['--profile', 'media', '--profile', 'scanner', '--profile', 'telemetry', 'down']); break;
  case 'media': {
    await run(['--profile', 'media', 'up', '-d', 'livekit']);
    const { loadConfig } = await import('@chat/config'), { LiveKitProvider } = await import('@chat/domain');
    const media = new LiveKitProvider(loadConfig()), deadline = Date.now() + 30000;
    while (!await media.health()) {
      if (Date.now() >= deadline) throw new Error('LiveKit RoomService did not become ready');
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    console.log('LiveKit authenticated RoomService ready'); break;
  }
  case 'telemetry': {
    const { telemetryDirectory } = await import('./telemetry-runtime.js');
    process.env['TELEMETRY_RUNTIME_DIR'] = await telemetryDirectory();
    await run(['--profile', 'telemetry', 'up', '-d', '--build', 'telemetry-relay', 'collector', 'prometheus', 'alertmanager']);
    console.log('Loopback telemetry profile started; run pnpm ops:telemetry for fresh host snapshots.'); break;
  }
  case 'scanner': await run(['--profile', 'scanner', 'build', 'image-processor']); await start(['--profile', 'scanner', 'up', '-d', '--wait', '--wait-timeout', '900', 'clamav', 'image-processor', 'image-proxy']); break;
  case 'diagnose': await diagnose(); break;
  default: throw new Error('Usage: infra.ts config|up|down|media|scanner|telemetry|diagnose');
}
