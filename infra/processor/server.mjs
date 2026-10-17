import { createServer } from 'node:http';
import { setTimeout, clearTimeout } from 'node:timers';
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import process from 'node:process';
import { Buffer } from 'node:buffer';
const limit = 26214400, key = Buffer.from(process.env.IMAGE_PROCESSOR_KEY ?? '');
if (key.length < 32) throw new Error('Image processor requires a private key');
let busy = false;
const server = createServer(async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.url === '/health/ready' && request.method === 'GET') { response.writeHead(200).end('ready'); return; }
  const supplied = Buffer.from((request.headers.authorization ?? '').replace(/^Bearer /, ''));
  if (supplied.length !== key.length || !timingSafeEqual(supplied, key)) { response.writeHead(403).end(); return; }
  const type = request.url?.split('/')[2];
  if (request.method !== 'POST' || !['jpeg', 'png', 'webp'].includes(type) || request.url !== `/transform/${type}`) { response.writeHead(400).end(); return; }
  if (busy) { response.writeHead(503).end(); return; }
  if (!Number.isInteger(Number(request.headers['content-length'])) || Number(request.headers['content-length']) < 1 || Number(request.headers['content-length']) > limit) { response.writeHead(413).end(); return; }
  busy = true; let child;
  const deadline = setTimeout(() => { child?.kill('SIGKILL'); request.destroy(); response.destroy(); }, 20000);
  try {
    const chunks = []; let size = 0;
    for await (const piece of request) { size += piece.length; if (size > limit) throw new Error('Input limit'); chunks.push(piece); }
    child = spawn(process.execPath, ['--max-old-space-size=128', 'child.mjs', type], { cwd: '/app', env: { NODE_ENV: 'production', PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'ignore'] });
    child.stdin.on('error', () => {}); const output = []; let length = 0;
    child.stdout.on('data', data => { length += data.length; if (length > limit) child.kill('SIGKILL'); else output.push(data); });
    const result = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => code === 0 && length > 0 && length <= limit ? resolve(Buffer.concat(output)) : reject(new Error('Decode rejected'))); });
    child.stdin.end(Buffer.concat(chunks));
    const bytes = await result; response.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': bytes.length }).end(bytes);
  } catch { if (!response.destroyed) response.writeHead(422).end('Image rejected'); }
  finally { clearTimeout(deadline); child?.kill('SIGKILL'); busy = false; }
});
server.requestTimeout = 20000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 8;
server.listen(3003, '0.0.0.0');
