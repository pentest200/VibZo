import { readFile, writeFile } from 'node:fs/promises';
import { loadConfig } from '@chat/config';
import { createMongoClient } from '@chat/domain';
import { setupIdentity } from './clean-setup-policy.js';

const owner = process.env['SETUP_REHEARSAL_OWNER'] ?? '', config = loadConfig();
if (config.NODE_ENV !== 'test' || config.MONGODB_DATABASE !== setupIdentity(owner).database || !/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(config.MONGODB_URI)) throw new Error('Only isolated setup targets are admitted');
const operation = process.argv[2];
if (!['capture', 'verify'].includes(operation ?? '')) throw new Error('Use capture|verify');
const client = createMongoClient(config);
try {
  await client.connect();
  const db = client.db(config.MONGODB_DATABASE), markers = await db.collection('schemaMigrations').find().sort({ _id: 1 }).toArray();
  const expected = ['001_auth', '002_conversations', '003_messaging', '004_sync', '005_attachments', '006_safety', '007_calls', '008_operations', '009_avatars'];
  if (JSON.stringify(markers.map(row => row._id)) !== JSON.stringify(expected) || markers.some(row => !(row['appliedAt'] instanceof Date))) throw new Error('Expected all nine actual migration markers');
  const actual = JSON.stringify(markers);
  if (operation === 'capture') await writeFile('.cache/setup-markers.json', actual, { flag: 'wx', mode: 0o600 });
  else if (actual !== await readFile('.cache/setup-markers.json', 'utf8')) throw new Error('Migration markers changed across repeated migration/restart');
  if ((await db.admin().command({ hello: 1 }))['isWritablePrimary'] !== true) throw new Error('Setup replica is not writable');
  console.info('All nine migration markers match; replica is writable');
} finally { await client.close(); }
