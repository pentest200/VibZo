import { spawn } from 'node:child_process';
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
async function run(args: string[], allowFailure = false): Promise<boolean> {
  return new Promise<boolean>((success, fail) => {
    const child = spawn('docker', [...base, ...args], { stdio: 'inherit', shell: false });
    child.once('error', fail); child.once('exit', code => code === 0 ? success(true) : allowFailure ? success(false) : fail(new Error(`Docker command failed (${code}); ensure a Linux-container Docker engine is running`)));
  });
}
const operation = process.argv[2];
if (!existsSync('infra/compose/compose.yaml')) throw new Error('Run from repository root');
switch (operation) {
  case 'config': await run(['--profile', 'media', '--profile', 'scanner', 'config', '--quiet']); break;
  case 'up':
    await run(['up', '-d', '--wait', '--wait-timeout', '240']);
    if (!await run(['exec', '-T', 'garage', '/garage', 'bucket', 'info', 'chat-approved'], true)) {
      await run(['exec', '-T', 'garage', '/garage', 'bucket', 'create', 'chat-approved']);
    }
    await run(['exec', '-T', 'garage', '/garage', 'bucket', 'allow', '--read', '--write', '--owner', 'chat-approved', '--key', 'GK00000000000000000000000000000001']);
    await import('./configure-attachments.js');
    break;
  case 'down': await run(['--profile', 'media', '--profile', 'scanner', 'down']); break;
  case 'media': await run(['--profile', 'media', 'up', '-d', 'livekit']); break;
  case 'scanner': await run(['--profile', 'scanner', 'build', 'image-processor']); await run(['--profile', 'scanner', 'up', '-d', '--wait', '--wait-timeout', '900', 'clamav', 'image-processor', 'image-proxy']); break;
  default: throw new Error('Usage: infra.ts config|up|down|media|scanner');
}
