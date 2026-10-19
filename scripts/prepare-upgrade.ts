import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { privatePath } from './recovery/runtime.js';
const execute = promisify(execFile);
export const priorRevision = 'f4396e3';
export async function prepareUpgradeArtifact() {
  const root = await realpath('.');
  const commit = (await execute('git', ['rev-parse', `${priorRevision}^{commit}`])).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Prior commit identity unavailable');
  const directory = resolve('.cache/upgrade-artifacts', priorRevision), marker = join(directory, 'upgrade-artifact.json');
  const archive = await privatePath(`.cache/upgrade-artifacts/${commit}.tar`);
  if (existsSync(directory) && await realpath(directory) !== directory) throw new Error('Artifact directory cannot redirect');
  const hash = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex');
  const pnpm = resolve('.cache/pnpm-cli/node_modules/pnpm', process.platform === 'win32' ? 'pnpm.exe' : 'bin/pnpm.mjs');
  const run = async (args: string[]) => {
    const command = process.platform === 'win32' ? pnpm : process.execPath;
    await execute(command, process.platform === 'win32' ? args : [pnpm, ...args], { cwd: directory, windowsHide: true, timeout: 300000, maxBuffer: 1048576, env: { ...process.env, CI: 'true' } });
  };
  if (existsSync(marker)) {
    const saved = JSON.parse(await readFile(marker, 'utf8')) as { commit: string; domainSha256: string; lockSha256: string; apiSha256?: string };
    if (saved.commit !== commit || saved.domainSha256 !== await hash(join(directory, 'packages/domain/dist/index.js')) || saved.lockSha256 !== await hash(join(directory, 'pnpm-lock.yaml'))) throw new Error('Cached prior artifact differs; use a fresh reviewed artifact directory');
    if (!saved.apiSha256) {
      await run(['--filter', '@chat/api...', 'build']);
      saved.apiSha256 = await hash(join(directory, 'apps/api/dist/app.js')); await writeFile(marker, JSON.stringify(saved));
    }
    if (saved.apiSha256 !== await hash(join(directory, 'apps/api/dist/app.js'))) throw new Error('Cached prior API artifact differs');
    return { directory, ...saved, apiSha256: saved.apiSha256 };
  }
  await mkdir(resolve('.cache/upgrade-artifacts'), { recursive: true });
  const sourceMarker = join(directory, 'upgrade-source.json');
  if (!existsSync(directory)) {
    await mkdir(directory);
    await execute('git', ['archive', '--format=tar', `--output=${archive}`, commit], { timeout: 30000 });
    if ((await stat(archive)).size > 64 * 1048576) throw new Error('Prior source archive exceeds local budget');
    await execute('tar', ['-xf', archive, '-C', directory], { timeout: 30000 });
    await writeFile(sourceMarker, JSON.stringify({ commit, lockSha256: await hash(join(directory, 'pnpm-lock.yaml')) }), { flag: 'wx' });
  }
  const source = JSON.parse(await readFile(sourceMarker, 'utf8')) as { commit: string; lockSha256: string };
  if (source.commit !== commit || source.lockSha256 !== await hash(join(directory, 'pnpm-lock.yaml'))) throw new Error('Occupied artifact does not match prior source');
  await run(['install', '--offline', '--frozen-lockfile', `--config.cacheDir=${join(root, '.cache/pnpm')}`, '--store-dir', join(root, '.pnpm-store'), '--state-dir', join(directory, '.cache/state')]);
  await run(['--filter', '@chat/api...', 'build']);
  const result = { commit, domainSha256: await hash(join(directory, 'packages/domain/dist/index.js')), apiSha256: await hash(join(directory, 'apps/api/dist/app.js')), lockSha256: await hash(join(directory, 'pnpm-lock.yaml')) };
  await writeFile(marker, JSON.stringify(result), { flag: 'wx' });
  return { directory, ...result };
}
if (process.argv[1] && resolve(process.argv[1]) === resolve('scripts/prepare-upgrade.ts')) console.log(JSON.stringify(await prepareUpgradeArtifact()));
