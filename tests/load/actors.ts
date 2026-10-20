import type { APIRequestContext } from '@playwright/test';
import type { AuthSession } from '@chat/contracts';
import { randomUUID } from 'node:crypto';
import { Agent, request as httpRequest } from 'node:http';
import { setTimeout as pause } from 'node:timers/promises';
import { password } from '../e2e/chat-fixture.js';
import { budget } from './policy.js';
let nextSource = 2;
class LocalClient {
  private readonly agent = new Agent({ keepAlive: true, maxSockets: 4 });
  cookie = '';
  constructor(private readonly source: string) {}
  get(path: string) { return this.send('GET', path); }
  post(path: string, options: { data: unknown; headers?: Record<string, string> }) { return this.send('POST', path, options.data, options.headers); }
  private async send(method: string, path: string, data?: unknown, headers: Record<string, string> = {}) {
    if (!path.startsWith('/api/v1/') || path.includes('://')) throw new Error('Load API path rejected');
    const body = data === undefined ? undefined : Buffer.from(JSON.stringify(data));
    return new Promise<{ status: () => number; json: () => Promise<unknown> }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: 3000, localAddress: this.source, path, method, agent: this.agent, signal: AbortSignal.timeout(10000), headers: { Origin: 'http://localhost:5173', Cookie: this.cookie, ...headers, ...(body ? { 'Content-Type': 'application/json', 'Content-Length': body.length } : {}) } }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > budget.reportBytes) response.destroy(new Error('Load response bound')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          const cookie = response.headers['set-cookie']?.find(value => value.startsWith('commonroom_session=')); if (cookie) this.cookie = cookie.split(';')[0]!;
          resolve({ status: () => response.statusCode ?? 0, json: async () => JSON.parse(Buffer.concat(chunks).toString()) as unknown });
        });
      });
      request.on('error', reject); request.end(body);
    });
  }
  async dispose() { this.agent.destroy(); }
}
export interface Actor { id: string; username: string; email: string; csrf: string; cookie: string; api: LocalClient }
export async function actor(request: APIRequestContext, label: string): Promise<Actor> {
  if (nextSource > 13) throw new Error('Load account budget exceeded');
  const api = new LocalClient(`127.0.0.${nextSource++}`), username = `${label}_${randomUUID().slice(0, 8)}`, user = { username, email: `${username}@example.test` };
  try {
    if ((await api.post('/api/v1/auth/register', { data: { ...user, displayName: label, password } })).status() !== 202) throw new Error('Load registration failed');
    const mail = process.env['MAILPIT_URL']; if (!mail || new URL(mail).hostname !== '127.0.0.1') throw new Error('Load mail must be owned loopback');
    let token = ''; const until = performance.now() + 20000;
    while (!token && performance.now() < until) {
      const messages = await (await request.get(`${mail}/api/v1/search?query=${encodeURIComponent(`to:${user.email}`)}`)).json() as { messages: { ID: string }[] };
      for (const message of messages.messages.slice(0, 3)) { const body = await (await request.get(`${mail}/api/v1/message/${message.ID}`)).json() as { Text: string }; token = body.Text.match(/\/verify#token=([A-Za-z0-9_-]{43})/)?.[1] ?? ''; if (token) break; }
      if (!token) await pause(100);
    }
    if (!token || (await api.post('/api/v1/auth/verify', { data: { token } })).status() !== 200) throw new Error('Load verification failed');
    const response = await api.post('/api/v1/auth/login', { data: { email: user.email, password } });
    if (response.status() !== 200) throw new Error('Load login failed');
    const session = await response.json() as AuthSession;
    if (!api.cookie) throw new Error('Load session cookie missing');
    return { ...user, id: session.user.id, csrf: session.csrfToken, cookie: api.cookie, api };
  } catch (error) { await api.dispose(); throw error; }
}
export async function post<T>(actor: Actor, path: string, data: unknown = {}, status = 200): Promise<T> {
  const response = await actor.api.post(`/api/v1${path}`, { data, headers: { 'X-CSRF-Token': actor.csrf } });
  if (response.status() !== status) throw new Error(`Load HTTP status ${response.status()}`);
  return await response.json() as T;
}
export async function group(actors: Actor[]) {
  const owner = actors[0]!;
  const { conversationId } = await post<{ conversationId: string }>(owner, '/conversations/groups', { title: 'Load measurement group', clientCommandId: randomUUID() });
  for (const member of actors.slice(1)) { await post(owner, `/conversations/${conversationId}/invitations`, { targetUserId: member.id }); await post(member, `/conversations/${conversationId}/accept`); }
  return conversationId;
}
