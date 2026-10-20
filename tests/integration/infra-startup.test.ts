import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { expect, it } from 'vitest';

const execute = promisify(execFile);
const docker = (args: string[], timeout = 15000) => execute('docker', ['--config', '.cache/docker', ...args], { windowsHide: true, timeout, maxBuffer: 1048576 });
interface State { Running: boolean; OOMKilled: boolean; Health?: { Status: string; Log: { ExitCode: number; Output: string }[] } }

it('cold-boots the pinned replica, retains transactions/config across restart, and rejects standalone readiness with useful diagnostics', async () => {
  if (await realpath('.cache') !== resolve('.cache')) throw new Error('Fixture cache cannot redirect');
  const owner = randomBytes(6).toString('hex'), project = `commonroom-infra-test-${owner}`, container = `${project}-mongo-1`;
  const directory = resolve(`.cache/infra-startup-${owner}`); await mkdir(directory);
  const source = JSON.parse((await docker(['compose', '-f', 'infra/compose/compose.yaml', 'config', '--format', 'json'])).stdout) as { services: { mongo: Record<string, unknown> } };
  const mongo = source.services.mongo, probe = (mongo['healthcheck'] as { test: string[] }).test;
  if (probe[0] !== 'CMD' || probe[1] !== 'mongosh') throw new Error('Unexpected Mongo probe contract');
  const uri = probe.find(value => value.startsWith('mongodb://')); if (!uri) throw new Error('Probe must select explicit loopback');
  delete mongo['ports']; delete mongo['restart']; delete mongo['networks']; delete mongo['container_name'];
  const labels = { 'commonroom.infra-startup': owner };
  Object.assign(mongo, { volumes: ['fresh:/data/db'], labels, mem_limit: '1g', cpus: 1 });
  const file = resolve(directory, 'compose.json'), config = { services: { mongo }, volumes: { fresh: { labels } }, networks: { default: { labels } } };
  const save = () => writeFile(file, JSON.stringify(config, null, 2));
  const base = ['compose', '-p', project, '-f', file];
  const state = async () => JSON.parse((await docker(['inspect', '--format', '{{json .State}}', container])).stdout) as State;
  const shell = (script: string) => docker(['exec', container, 'mongosh', '--norc', '--quiet', uri, '--eval', script]);
  const owned = async (kind: string, name: string) => {
    const format = kind === 'container' ? '{{json .Config.Labels}}' : '{{json .Labels}}';
    const value = JSON.parse((await docker([kind, 'inspect', '--format', format, name])).stdout) as Record<string, string>;
    if (value['commonroom.infra-startup'] !== owner) throw new Error('Refusing foreign fixture operation');
  };
  const cleanup = async () => {
    try {
      for (const [kind, name] of [['container', container], ['volume', `${project}_fresh`], ['network', `${project}_default`]] as const) {
        try { await owned(kind, name); }
        catch (error) { if (/No such|not found/i.test((error as { stderr?: string }).stderr ?? '')) continue; throw error; }
      }
      await docker([...base, 'down', '--volumes'], 30000);
    } catch (error) { console.error('Owned startup fixture cleanup failed; inspect', directory); throw error; }
  };
  let passed = false;
  try {
    await save();
    await docker([...base, 'up', '-d', '--wait', '--wait-timeout', '120'], 135000);
    expect(await state()).toMatchObject({ Running: true, OOMKilled: false, Health: { Status: 'healthy' } });
    const first = JSON.parse((await shell('print(JSON.stringify({_id:rs.conf()._id,version:rs.conf().version,primary:db.hello().isWritablePrimary}))')).stdout) as unknown;
    expect(first).toMatchObject({ _id: 'rs0', primary: true });
    // Actual majority-journaled multi-collection commit and abort, not just ping.
    const transaction = await shell(`
      const target=db.getSiblingDB('startup_probe'); target.createCollection('accepted'); target.createCollection('outbox');
      const session=db.getMongo().startSession(), work=session.getDatabase('startup_probe');
      const options={readConcern:{level:'snapshot'},writeConcern:{w:'majority',j:true,wtimeout:5000}};
      session.startTransaction(options); work.accepted.insertOne({_id:'commit'}); work.outbox.insertOne({_id:'commit'}); session.commitTransaction();
      session.startTransaction(options); work.accepted.insertOne({_id:'abort'}); work.outbox.insertOne({_id:'abort'}); session.abortTransaction(); session.endSession();
      print(JSON.stringify({accepted:target.accepted.countDocuments({}),outbox:target.outbox.countDocuments({}),aborted:target.accepted.countDocuments({_id:'abort'})+target.outbox.countDocuments({_id:'abort'})}));
    `);
    expect(JSON.parse(transaction.stdout)).toEqual({ accepted: 1, outbox: 1, aborted: 0 });
    await owned('container', container);
    await docker([...base, 'restart', 'mongo'], 30000);
    await docker([...base, 'up', '-d', '--wait', '--wait-timeout', '120'], 135000);
    const after = JSON.parse((await shell('print(JSON.stringify({_id:rs.conf()._id,version:rs.conf().version,primary:db.hello().isWritablePrimary}))')).stdout) as unknown;
    expect(after).toEqual(first);
    expect(JSON.parse((await shell("print(JSON.stringify({accepted:db.getSiblingDB('startup_probe').accepted.countDocuments({}),outbox:db.getSiblingDB('startup_probe').outbox.countDocuments({})}))")).stdout)).toEqual({ accepted: 1, outbox: 1 });
    // A writable standalone is deliberately NOT a ready transaction dependency.
    // Only this owned fixture is recreated; its original volume remains attached.
    mongo['command'] = ['mongod', '--bind_ip_all']; await save();
    await owned('container', container);
    await docker([...base, 'up', '-d', '--no-deps', '--force-recreate', 'mongo'], 30000);
    const deadline = Date.now() + 20000;
    for (;;) {
      try { expect(JSON.parse((await shell('print(JSON.stringify(db.adminCommand({hello:1})))')).stdout)).toMatchObject({ isWritablePrimary: true }); break; }
      catch (error) { if (Date.now() >= deadline) throw error; await pause(250); }
    }
    await expect(docker(['exec', container, ...probe.slice(1)])).rejects.toMatchObject({ code: 1 });
    const healthDeadline = Date.now() + 15000;
    while (!(await state()).Health?.Log.some(row => row.ExitCode !== 0)) {
      if (Date.now() >= healthDeadline) throw new Error('Missing actual negative health observation'); await pause(250);
    }
    const diagnostic = await execute(process.execPath, [resolve('node_modules/tsx/dist/cli.mjs'), 'scripts/infra.ts', 'diagnose'], {
      env: { ...process.env, COMPOSE_PROJECT_NAME: project }, windowsHide: true, timeout: 30000, maxBuffer: 65536,
    });
    expect(diagnostic.stderr).toContain(container); expect(diagnostic.stderr).toContain('"Health"'); expect(diagnostic.stderr).toContain('"ExitCode":1');
    expect(diagnostic.stderr).not.toContain('"Env"'); expect(diagnostic.stderr).not.toContain('commonroom-local-mongo');
    passed = true;
  } finally {
    try { await writeFile(resolve(directory, 'outcome.json'), JSON.stringify({ passed, state: await state().catch(() => null) })); }
    finally { await cleanup(); }
  }
});
