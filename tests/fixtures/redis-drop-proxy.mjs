// Test-only fault proxy. All commands go to real Redis, except selected body-free live publications.
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { createServer as tcpServer, connect } from 'node:net';
import { createServer as httpServer } from 'node:http';
if (process.env.NODE_ENV !== 'test') throw new Error('Redis fault proxy is test-only');
let drop = false, suppressed = 0;
const destination = new URL(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
function frame(buffer) {
  const line = buffer.indexOf('\r\n'); if (line < 0) return null;
  if (buffer[0] !== 42) throw new Error('Expected RESP command array');
  const count = Number(buffer.subarray(1, line).toString()); if (!Number.isInteger(count) || count < 1 || count > 1024) throw new Error('Invalid command size');
  let offset = line + 2; const args = [];
  for (let index = 0; index < count; index++) {
    const end = buffer.indexOf('\r\n', offset); if (end < 0) return null;
    if (buffer[offset] !== 36) throw new Error('Expected RESP bulk string');
    const size = Number(buffer.subarray(offset + 1, end).toString()); if (!Number.isInteger(size) || size < 0 || size > 1024 * 1024) throw new Error('Invalid argument');
    if (buffer.length < end + 2 + size + 2) return null;
    args.push(buffer.subarray(end + 2, end + 2 + size).toString()); offset = end + 2 + size + 2;
  }
  return { args, offset };
}
const proxy = tcpServer(incoming => {
  const outgoing = connect(Number(destination.port || 6379), destination.hostname); let buffered = Buffer.alloc(0);
  incoming.on('error', () => outgoing.destroy()); outgoing.on('error', () => incoming.destroy());
  incoming.on('close', () => outgoing.destroy()); outgoing.on('close', () => incoming.destroy());
  outgoing.pipe(incoming);
  incoming.on('data', data => {
    buffered = Buffer.concat([buffered, data]); if (buffered.length > 2 * 1024 * 1024) { incoming.destroy(); return; }
    try {
      for (;;) {
        const command = frame(buffered); if (!command) break;
        // FanoutWorker awaits each publish; this injected reply cannot overtake another command on that connection.
        if (drop && command.args[0]?.toUpperCase() === 'PUBLISH' && command.args[1]?.endsWith('.sync')) { suppressed++; incoming.write(':0\r\n'); }
        else outgoing.write(buffered.subarray(0, command.offset));
        buffered = buffered.subarray(command.offset); if (!buffered.length) break;
      }
    } catch { incoming.destroy(); outgoing.destroy(); }
  });
});
proxy.listen(16380, '127.0.0.1');
httpServer((request, response) => {
  if (request.method === 'POST' && request.url === '/drop') drop = true;
  else if (request.method === 'POST' && request.url === '/pass') drop = false;
  else if (request.method !== 'GET' || request.url !== '/health') { response.writeHead(404).end(); return; }
  response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ drop, suppressed }));
}).listen(16381, '127.0.0.1');
