import { createClient } from 'redis';
import { loadConfig } from '@chat/config';
import { syncChannel } from '@chat/domain';
import { connect } from 'node:net';
export async function assertLoadListenersStopped() {
  for (const port of [3000, 3001, 3002, 5173, 16380, 16381]) await new Promise<void>((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); reject(new Error('Load listeners must stop before cleanup')); });
    socket.once('error', (error: NodeJS.ErrnoException) => { socket.destroy(); if (error.code === 'ECONNREFUSED') resolve(); else reject(new Error('Cannot establish stopped load listener')); });
    socket.setTimeout(1000, () => { socket.destroy(); reject(new Error('Load listener probe timeout')); });
  });
}
export async function cleanLoadEphemeral(database: string) {
  if (!/^chat_e2e_auth_[a-f0-9]{32}$/.test(database)) throw new Error('Refusing non-fixture Redis cleanup');
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: database });
  const client = createClient({ url: config.REDIS_URL, socket: { connectTimeout: 3000, reconnectStrategy: false } }); client.on('error', () => {});
  try {
    await client.connect(); let removed = 0;
    for (const prefix of [`auth:${database}:`, `${syncChannel(config)}:`]) {
      let cursor = '0';
      do {
        const response = await client.withCommandOptions({ timeout: 3000 }).sendCommand(['SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', '128']) as [string, string[]]; cursor = response[0];
        if (!Array.isArray(response[1]) || response[1].some(key => !key.startsWith(prefix)) || removed + response[1].length > 2048) throw new Error('Redis cleanup identity/budget');
        if (response[1].length) removed += Number(await client.withCommandOptions({ timeout: 3000 }).sendCommand(['DEL', ...response[1]]));
      } while (cursor !== '0');
    }
    return removed;
  } finally { if (client.isOpen) client.destroy(); }
}
