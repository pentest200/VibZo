import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile, unlink, realpath, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createSocket } from 'node:dgram';
import { loadConfig } from '@chat/config';
import { LiveKitProvider } from '@chat/domain';
import { reservePort } from './telemetry-fixture.js';
import { waitFor } from './messaging-fixture.js';
const execute = promisify(execFile), docker = ['--config', '.cache/docker'];
export async function controlUpgradeMedia(action: 'kill' | 'start') {
  const name = process.env['UPGRADE_MEDIA_NAME'], owner = process.env['UPGRADE_MEDIA_OWNER'];
  if (!name || !/^commonroom-upgrade-media-[a-f0-9]{12}$/.test(name) || !owner || name !== `commonroom-upgrade-media-${owner}`) throw new Error('No owned upgrade media fixture');
  const labels = JSON.parse((await execute('docker', [...docker, 'inspect', '--format', '{{json .Config.Labels}}', name], { windowsHide: true, timeout: 10000 })).stdout) as Record<string, string>;
  if (labels['commonroom.upgrade'] !== owner) throw new Error('Media fixture identity differs');
  await execute('docker', [...docker, action, ...(action === 'kill' ? ['--signal=KILL'] : []), name], { windowsHide: true, timeout: 20000 });
  return JSON.parse((await execute('docker', [...docker, 'inspect', '--format', '{{json .State}}', name], { windowsHide: true, timeout: 10000 })).stdout) as { Running: boolean; ExitCode: number };
}
export async function upgradeMediaFixture(options: { webhookPort?: number; turn?: boolean } = {}) {
  if (options.webhookPort !== undefined && (!Number.isInteger(options.webhookPort) || options.webhookPort < 1024 || options.webhookPort > 65535)) throw new Error('Invalid owned fixture webhook port');
  const owner = randomBytes(6).toString('hex'), name = `commonroom-upgrade-media-${owner}`, mail = `commonroom-upgrade-mail-${owner}`, directory = resolve(`.cache/upgrade-media-${owner}`);
  if (await realpath('.cache') !== resolve('.cache')) throw new Error('Fixture cache cannot redirect');
  await mkdir(directory);
  const [http, tcp, smtp, mailHttp] = await Promise.all([reservePort(), reservePort(), reservePort(), reservePort()]);
  const socket = createSocket('udp4'); await new Promise<void>(done => socket.bind(0, '127.0.0.1', done)); const udp = socket.address().port; await new Promise<void>(done => socket.close(done));
  let turnPort = 0, relayFrom = 0;
  if (options.turn) {
    const turn = createSocket('udp4'); await new Promise<void>(done => turn.bind(0, '127.0.0.1', done)); turnPort = turn.address().port; await new Promise<void>(done => turn.close(done));
    // Reserve/check a finite private relay range; collisions fail rather than
    // replacing any listener or borrowing the ordinary SFU allocation ports.
    for (let attempt = 0; attempt < 5 && !relayFrom; attempt++) {
      const candidate = 52000 + randomBytes(2).readUInt16BE() % 8000, sockets: ReturnType<typeof createSocket>[] = [];
      try { for (let offset = 0; offset < 32; offset++) { const current = createSocket('udp4'); sockets.push(current); await new Promise<void>((done, fail) => { current.once('error', fail); current.bind(candidate + offset, '127.0.0.1', done); }); } relayFrom = candidate; }
      catch { /* bounded collision search */ }
      finally { for (const current of sockets) { try { current.close(); } catch { /* not bound */ } } }
    }
    if (!relayFrom) throw new Error('No private relay range available');
  }
  const key = `upgrade${owner}`, secret = randomBytes(32).toString('hex'), path = resolve(directory, 'livekit.yaml');
  await writeFile(path, `port: ${http}\nbind_addresses: ['0.0.0.0']\nrtc:\n  tcp_port: ${tcp}\n  udp_port: ${udp}\n  use_external_ip: false\n  node_ip: 127.0.0.1\nkeys:\n  ${key}: ${secret}\nroom:\n  auto_create: false\n  max_participants: 12\n  empty_timeout: 90\n  departure_timeout: 60\n${options.webhookPort ? `webhook:\n  api_key: ${key}\n  urls: ['http://host.docker.internal:${options.webhookPort}/api/v1/webhooks/livekit']\n` : ''}logging:\n  level: error\n`, { mode: 0o600, flag: 'wx' });
  if (options.turn) await writeFile(path, (await readFile(path, 'utf8')).replace('  node_ip: 127.0.0.1\n', '  node_ip: 127.0.0.1\n  enable_loopback_candidate: true\n') + `turn:\n  enabled: true\n  udp_port: ${turnPort}\n  relay_range_start: ${relayFrom}\n  relay_range_end: ${relayFrom + 31}\n  allow_restricted_peer_cidrs: ['127.0.0.1/32']\n`, { mode: 0o600 });
  const env = { UPGRADE_MEDIA_NAME: name, UPGRADE_MEDIA_OWNER: owner, LIVEKIT_API_URL: `http://127.0.0.1:${http}`, LIVEKIT_URL: `ws://127.0.0.1:${http}`, LIVEKIT_API_KEY: key, LIVEKIT_API_SECRET: secret, CALLS_ENABLED: 'true', SMTP_PORT: String(smtp), MAILPIT_URL: `http://127.0.0.1:${mailHttp}` };
  const run = async (args: string[]) => execute('docker', [...docker, ...args], { windowsHide: true, timeout: 30000, maxBuffer: 32768 });
  const owned = new Set<string>();
  const close = async () => {
    for (const container of [...owned].reverse()) {
      let labels: Record<string, string>;
      try { labels = JSON.parse((await run(['inspect', '--format', '{{json .Config.Labels}}', container])).stdout) as Record<string, string>; }
      catch (error) { if (/No such (object|container)/i.test(String((error as { stderr?: string }).stderr))) { owned.delete(container); continue; } throw error; }
      if (labels['commonroom.upgrade'] !== owner) throw new Error('Refusing foreign fixture cleanup');
      await run(['rm', '-f', container]); owned.delete(container);
    }
    await unlink(path);
  };
  try {
    owned.add(name);
    await run(['run', '-d', '--name', name, '--label', `commonroom.upgrade=${owner}`, ...(options.webhookPort ? ['--add-host', 'host.docker.internal:host-gateway'] : []), '--memory', '512m', '--cpus', '1', '--pids-limit', '128', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges:true', '--user', `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, '--tmpfs', '/tmp:rw,size=16m', '--mount', `type=bind,source=${path},target=/etc/livekit.yaml,readonly`, '-p', `127.0.0.1:${http}:${http}`, '-p', `127.0.0.1:${tcp}:${tcp}`, '-p', `127.0.0.1:${udp}:${udp}/udp`, ...(options.turn ? ['-p', `127.0.0.1:${turnPort}:${turnPort}/udp`, '-p', `127.0.0.1:${relayFrom}-${relayFrom + 31}:${relayFrom}-${relayFrom + 31}/udp`] : []), 'livekit/livekit-server:v1.13.9@sha256:d0c04791bf63ca8dcea123571827d56ba9504bd57c8d5de60ee03b5408cc3154', '--config', '/etc/livekit.yaml']);
    const ports = JSON.parse((await run(['inspect', '--format', '{{json .NetworkSettings.Ports}}', name])).stdout) as Record<string, { HostIp: string }[] | null>;
    const bindings = Object.values(ports).flatMap(value => value ?? []);
    if (bindings.length !== (options.turn ? 36 : 3) || bindings.some(value => value.HostIp !== '127.0.0.1')) throw new Error('Media fixture must publish only its expected loopback bindings');
    owned.add(mail);
    await run(['run', '-d', '--name', mail, '--label', `commonroom.upgrade=${owner}`, '--memory', '128m', '--cpus', '0.25', '--pids-limit', '64', '-p', `127.0.0.1:${smtp}:1025`, '-p', `127.0.0.1:${mailHttp}:8025`, 'axllent/mailpit:v1.31.5@sha256:94f6b70c1436defae6799d9ac7ff0eeff9540465b842026d5cdb018f1c0234ea', '--smtp-disable-rdns']);
    const provider = new LiveKitProvider(loadConfig({ ...process.env, ...env, NODE_ENV: 'test' }));
    await waitFor(() => provider.health(), 30000);
    return { env, close };
  } catch (error) { await writeFile(resolve(directory, 'startup.log'), (await run(['logs', '--tail', '30', name]).catch(() => ({ stdout: '', stderr: '' }))).stderr); await close(); throw error; }
}
