import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

const gates = ['test:e2e:ui', 'test:a11y', 'test:e2e:journey', 'test:e2e:auth', 'test:e2e:conversations', 'test:e2e:messaging', 'test:e2e:sync', 'test:e2e:attachments', 'test:e2e:avatars', 'test:e2e:safety', 'test:e2e:calls', 'test:e2e:upgrade'];
const from = process.argv[2];
if (process.argv.length > 3 || from && !gates.includes(from)) throw new Error('Usage: pnpm test:e2e [first-gate-name]');
const pnpm = process.env['npm_execpath']; if (!pnpm) throw new Error('Run through pnpm so the pinned package manager is used');
const directory = resolve('.cache', `browser-gates-${randomUUID()}`); await mkdir(directory);
console.info('Browser gate logs:', directory);
const results: { name: string; exitCode: number; passed: number | null; seconds: number; log: string; limitHit: boolean }[] = [];
for (const name of gates.slice(from ? gates.indexOf(from) : 0)) {
  const start = Date.now(), log = resolve(directory, `${name.replaceAll(':', '-')}.log`), output = createWriteStream(log, { flags: 'wx', mode: 0o600 });
  await writeFile(resolve(directory, 'current.json'), JSON.stringify({ name, log, status: 'running' }));
  const executable = pnpm.endsWith('.exe') ? pnpm : process.execPath, args = pnpm.endsWith('.exe') ? [name] : [pnpm, name];
  const child = spawn(executable, args, { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  let bytes = 0, limitHit = false;
  const stop = () => {
    if (limitHit) return; limitHit = true;
    if (!child.pid) return;
    // Terminate only this owned process tree. An outer hard kill still requires
    // ownership-checked fixture inspection; never drop a DB by prefix alone.
    if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ } }
  };
  const timer = setTimeout(stop, 900000);
  for (const input of [child.stdout, child.stderr]) input.on('data', (chunk: Buffer) => {
    const allowed = Math.max(0, 8 * 1048576 - bytes), part = chunk.subarray(0, allowed); bytes += part.length;
    if (!output.write(part)) { input.pause(); output.once('drain', () => input.resume()); }
    if (chunk.length > allowed) stop();
  });
  const code = await new Promise<number>(done => { child.once('error', () => done(1)); child.once('close', value => done(value ?? 1)); });
  clearTimeout(timer); output.end(); await finished(output);
  // Strip only ANSI SGR/control sequences; never print the raw private browser log.
  const clean = stripVTControlCharacters(await readFile(log, 'utf8')), match = clean.match(/^\s*(\d+)\s+passed\s*\(/m);
  const result = { name, exitCode: limitHit ? 1 : code, passed: match ? Number(match[1]) : null, seconds: (Date.now() - start) / 1000, log, limitHit };
  results.push(result); await writeFile(resolve(directory, 'results.json'), JSON.stringify(results));
  await writeFile(resolve(directory, 'current.json'), JSON.stringify({ ...result, status: 'finished' })); console.info(JSON.stringify(result));
  if (result.exitCode) { process.exitCode = 1; break; }
}
