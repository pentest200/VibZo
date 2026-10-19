import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, relative, isAbsolute, dirname } from 'node:path';
import { mkdir, realpath } from 'node:fs/promises';
import { BSON, Timestamp } from 'mongodb';
import type { Db, Document, MongoClient } from 'mongodb';
import type { Config } from '@chat/config';
import { RecoveryError } from './bundle.js';
const execute = promisify(execFile);
export function supportedMarkers(value: unknown): boolean {
  const ids = ['001_auth', '002_conversations', '003_messaging', '004_sync', '005_attachments', '006_safety', '007_calls', '008_operations', '009_avatars'];
  return Array.isArray(value) && [8, 9].includes(value.length) && value.every((row, index) => row && row._id === ids[index] && row.appliedAt instanceof Date && Number.isFinite(row.appliedAt.getTime()));
}
export const dockerBase = ['--config', '.cache/docker'];
function childEnvironment() { const env = { ...process.env }; delete env['RECOVERY_KEY']; return env; }
export async function privatePath(input: string) {
  const root = await realpath('.'), target = resolve(input), rel = relative(root, target).replaceAll('\\', '/');
  if (isAbsolute(rel) || !(rel.startsWith('.cache/') || rel.startsWith('infra/compose/.runtime/'))) throw new RecoveryError('Recovery artifacts must stay in ignored workspace storage');
  // Resolve the nearest existing ancestor before creating directories through possible junctions.
  let ancestor = dirname(target);
  for (;;) { try { const actual = await realpath(ancestor); if (relative(root, actual).replaceAll('\\', '/') !== relative(root, ancestor).replaceAll('\\', '/')) throw new RecoveryError('Recovery path cannot redirect'); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; const parent = dirname(ancestor); if (parent === ancestor) throw error; ancestor = parent; } }
  await mkdir(dirname(target), { recursive: true });
  const parent = await realpath(dirname(target));
  if (relative(root, parent).replaceAll('\\', '/') !== relative(root, dirname(target)).replaceAll('\\', '/')) throw new RecoveryError('Recovery directory cannot redirect');
  try { if (await realpath(target) !== target) throw new RecoveryError('Recovery file cannot redirect'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return target;
}
export function assertLocal(config: Config) {
  const uri = new URL(config.MONGODB_URI), storage = new URL(config.S3_ENDPOINT);
  if (config.NODE_ENV === 'production' || uri.protocol !== 'mongodb:' || uri.hostname !== '127.0.0.1' || (uri.port && uri.port !== '27017') || uri.username || uri.password || !['127.0.0.1', 'localhost'].includes(storage.hostname) || !/^[a-zA-Z][a-zA-Z0-9_]{0,50}$/.test(config.MONGODB_DATABASE)) throw new RecoveryError('Recovery tools support only the local Compose replica and loopback storage');
}
export async function mongoContainer(client: MongoClient) {
  const id = (await execute('docker', [...dockerBase, 'compose', '-f', 'infra/compose/compose.yaml', 'ps', '-q', 'mongo'], { env: childEnvironment(), windowsHide: true, timeout: 10000 })).stdout.trim();
  if (!/^[a-f0-9]{64}$/.test(id)) throw new RecoveryError('Compose Mongo container is unavailable');
  const host = await client.db('admin').command({ hello: 1 });
  const inside = (await execute('docker', [...dockerBase, 'exec', id, 'mongosh', '--quiet', '--eval', 'db.hello().topologyVersion.processId.toString()'], { env: childEnvironment(), windowsHide: true, timeout: 20000, maxBuffer: 4096 })).stdout.trim();
  if (!host['isWritablePrimary'] || !host['topologyVersion']?.processId || !inside.includes(String(host['topologyVersion'].processId))) throw new RecoveryError('Host and Compose Mongo identities differ');
  return id;
}
export function tool(container: string, program: 'mongodump' | 'mongorestore', args: string[]) {
  const child = spawn('docker', [...dockerBase, 'exec', '-i', container, program, '--host=127.0.0.1', '--port=27017', ...args], { env: childEnvironment(), windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const deadline = setTimeout(() => child.kill(), 120000).unref();
  const finished = new Promise<number | null>(done => { child.once('error', () => done(-1)); child.once('exit', code => { clearTimeout(deadline); done(code); }); });
  child.stdin.on('error', () => {});
  return { child, async finish() { if (await finished !== 0) throw new RecoveryError('Mongo recovery tool failed'); }, async stop() { child.stdin.destroy(); child.stdout.destroy(); child.kill(); await finished; } };
}
export const json = (value: unknown) => BSON.EJSON.stringify(value, { relaxed: false });
export const parse = <T>(value: string): T => BSON.EJSON.parse(value, { relaxed: false }) as T;
function sorted(value: unknown): unknown { if (Array.isArray(value)) return value.map(sorted); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sorted(item)])); return value; }
export const canonical = (value: unknown) => JSON.stringify(sorted(JSON.parse(json(value))));
export interface Catalog { name: string; count: number; options: unknown; indexes: unknown }
export async function catalog(db: Db): Promise<Catalog[]> {
  const result: Catalog[] = [];
  const collections = await db.listCollections().toArray(); if (collections.length > 80) throw new RecoveryError('Collection budget exceeded');
  for (const entry of collections.sort((a, b) => a.name.localeCompare(b.name))) {
    if (['restoreControl', 'schemaMigrations', 'migrationLocks'].includes(entry.name)) continue;
    if (entry.type !== 'collection' || !/^[a-zA-Z][a-zA-Z0-9_]{0,60}$/.test(entry.name)) throw new RecoveryError('Unsupported collection');
    const count = await db.collection(entry.name).countDocuments({}, { maxTimeMS: 3000, limit: 50001 }); if (count > 50000) throw new RecoveryError('Collection row budget exceeded');
    const indexes = (await db.collection(entry.name).listIndexes().toArray()).map(index => { const copy: Document = { ...index, key: Object.entries(index.key) }; delete copy['v']; delete copy['ns']; return copy; }).sort((a, b) => String(a['name']).localeCompare(String(b['name'])));
    result.push({ name: entry.name, count, options: 'options' in entry ? entry.options ?? {} : {}, indexes });
  }
  return result;
}
export async function authorityId(client: MongoClient) {
  const replica = await client.db('local').collection('system.replset').findOne();
  const id = String(replica?.['settings']?.replicaSetId ?? '');
  if (!/^[a-f0-9]{24}$/.test(id)) throw new RecoveryError('Replica authority identity unavailable'); return id;
}
async function latest(client: MongoClient) { const row = await client.db('local').collection('oplog.rs').findOne({}, { sort: { $natural: -1 }, projection: { ts: 1 } }); if (!(row?.['ts'] instanceof Timestamp)) throw new RecoveryError('Replica oplog required'); return row['ts']; }
export async function quiescent<T>(client: MongoClient, source: string, run: () => Promise<T>) {
  const start = await latest(client), result = await run(), end = await latest(client), log = client.db('local').collection('oplog.rs');
  const first = await log.findOne({}, { sort: { $natural: 1 }, projection: { ts: 1 } });
  if (!first?.['ts'] || (first['ts'] as Timestamp).compare(start) > 0) throw new RecoveryError('Oplog coverage lost during capture');
  const rows = await log.find({ ts: { $gt: start, $lte: end } }).limit(10001).maxTimeMS(3000).toArray();
  const relevant = (row: Document): boolean => {
    const op = row['o'] as Document | undefined;
    return typeof row['ns'] === 'string' && row['ns'].startsWith(source + '.') || !!op && (typeof op['renameCollection'] === 'string' && (op['renameCollection'].startsWith(source + '.') || String(op['to']).startsWith(source + '.')) || !!op['commitTransaction'] || !!op['prepare'] || Array.isArray(op['applyOps']) && op['applyOps'].some(relevant));
  };
  if (rows.length > 10000 || rows.some(relevant)) throw new RecoveryError('Source changed during capture; stop all writers and retry');
  return result;
}
