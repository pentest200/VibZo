import process from 'node:process';
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { open } from 'node:fs/promises';
const roles = ['api', 'gateway', 'worker', 'ops'];
const dependencies = ['mongodb', 'redis', 'rabbitmq', 'storage', 'scanner', 'image', 'livekit', 'smtp', 'push'];
const history = []; const counts = { firing: 0, resolved: 0 };
const freshMs = 30000;
async function snapshot(role) {
  const handle = await open(`/snapshots/${role}.json`, 'r');
  try {
    if ((await handle.stat()).size > 1048576) throw new Error('Snapshot limit');
    const body = JSON.parse(await handle.readFile('utf8'));
    if (body.v !== 1 || body.role !== role || !Number.isFinite(body.observedAt) || typeof body.metrics !== 'string' || body.metrics.length > 1000000 || ![body.up, body.live, body.ready].every(value => typeof value === 'boolean')) throw new Error('Invalid snapshot');
    const age = Date.now() - body.observedAt;
    if (age < -5000 || age > freshMs) return { body, fresh: false };
    return { body, fresh: true };
  } finally { await handle.close(); }
}
const server = createServer({ requestTimeout: 2000, headersTimeout: 2000, keepAliveTimeout: 1000 }, async (request, response) => {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method === 'GET' && request.url?.startsWith('/metrics/')) {
    const role = request.url.slice('/metrics/'.length); if (!roles.includes(role)) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    try {
      const { body, fresh } = await snapshot(role);
      response.end(`chat_snapshot_available 1\nchat_snapshot_fresh ${fresh ? 1 : 0}\nchat_snapshot_timestamp_seconds ${body.observedAt / 1000}\nchat_role_scrape_up ${fresh && body.up ? 1 : 0}\nchat_role_live ${fresh && body.live ? 1 : 0}\nchat_role_ready ${fresh && body.ready ? 1 : 0}\n${fresh ? body.metrics : ''}`);
    } catch { response.end('chat_snapshot_available 0\nchat_snapshot_fresh 0\nchat_role_scrape_up 0\n'); }
    return;
  }
  if (request.method === 'GET' && request.url === '/health/live') { response.end('alive'); return; }
  if (request.method === 'GET' && request.url === '/alerts') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ counts, history })); return; }
  if (request.method !== 'POST' || request.url !== '/alerts') { response.writeHead(404); response.end(); return; }
  let bytes = 0; const chunks = [];
  try {
    for await (const chunk of request) { bytes += chunk.length; if (bytes > 65536) throw new Error('Alert limit'); chunks.push(chunk); }
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!Array.isArray(data.alerts) || data.alerts.length > 50) throw new Error('Alert limit');
    for (const alert of data.alerts) {
      if (!['firing', 'resolved'].includes(alert.status) || typeof alert.labels?.alertname !== 'string' || !/^Commonroom[A-Za-z]{1,50}$/.test(alert.labels.alertname)) continue;
      const labels = { alertname: alert.labels.alertname };
      for (const [key, choices] of Object.entries({ role: roles, dependency: dependencies, severity: ['warning', 'critical'], queue: ['outbox', 'fanout', 'notification', 'attachment', 'push', 'email', 'deletion', 'fanout_dead', 'notification_dead'] })) if (choices.includes(alert.labels[key])) labels[key] = alert.labels[key];
      counts[alert.status]++; history.push({ status: alert.status, labels, receivedAt: Date.now() });
      if (history.length > 100) history.shift();
    }
    response.writeHead(204); response.end();
  } catch { response.writeHead(400); response.end('Invalid alert'); }
});
server.listen(9465, '0.0.0.0'); // Internal telemetry network only; no published host port.
process.once('SIGTERM', () => server.close());
process.once('SIGINT', () => server.close());
