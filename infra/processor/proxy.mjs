import { createServer, request as forward } from 'node:http';
// The decoder stays on an internal network. This bridge only forwards a fixed API;
// it has no credentials and performs no parsing of file contents.
const limit = 26214400;
const server = createServer((request, response) => {
  const health = request.method === 'GET' && request.url === '/health/ready';
  if (!health && (request.method !== 'POST' || !/^\/transform\/(jpeg|png|webp)$/.test(request.url ?? ''))) { response.writeHead(404).end(); return; }
  const length = Number(request.headers['content-length']);
  if (!health && (!Number.isInteger(length) || length < 1 || length > limit)) { response.writeHead(413).end(); return; }
  const upstream = forward({ host: 'image-processor', port: 3003, path: request.url, method: request.method, headers: health ? {} : { 'content-length': length, 'content-type': 'application/octet-stream', authorization: request.headers.authorization ?? '' }, timeout: 22000 }, result => {
    response.writeHead(result.statusCode ?? 503, { 'content-type': result.headers['content-type'] ?? 'text/plain', 'cache-control': 'no-store' });
    let received = 0; result.on('data', chunk => { received += chunk.length; if (received > limit) { result.destroy(); response.destroy(); } });
    result.on('error', () => response.destroy()); result.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy());
  upstream.on('error', () => { if (!response.headersSent) response.writeHead(503).end(); else response.destroy(); });
  let sent = 0; request.on('data', chunk => { sent += chunk.length; if (sent > limit) { upstream.destroy(); request.destroy(); } });
  request.on('error', () => upstream.destroy()); request.pipe(upstream);
});
server.requestTimeout = 22000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000; server.maxConnections = 8;
server.listen(3003, '0.0.0.0');
