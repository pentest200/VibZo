import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createApi } from '@chat/api';
import { loadConfig } from '@chat/config';
import { authSessionSchema, registerSchema } from '@chat/contracts';
import { AuthService, AuthEmailWorker, createMongoClient, migrateAuth, tokenHash, unseal, requireVerified } from '@chat/domain';
import type { EmailJobRecord, SessionRecord, TokenRecord, UserRecord } from '@chat/domain';

const config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: `auth_test_${randomUUID().replaceAll('-','')}`, MAX_SESSIONS: '2' });
const client = createMongoClient(config); const db = client.db(config.MONGODB_DATABASE);
const mailpitOrigin = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';
const auth = new AuthService(config, client, db);
let server: Awaited<ReturnType<typeof createApi>>; let base: string;
const password = 'Synthetic-test-password-123';
const email = (label: string) => `${label}_${randomUUID()}@example.test`;
async function user(label: string) {
  const input = registerSchema.parse({ email: email(label), username: `${label}_${randomUUID().slice(0,8)}`, displayName: label, password });
  await auth.register(input); return input;
}
async function request(path: string, method = 'GET', body?: unknown, cookie?: string, csrf?: string, origin = config.WEB_ORIGIN) {
  return fetch(`${base}/api/v1${path}`, { method, headers: { Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
async function login(email: string, previous?: string) {
  const response = await request('/auth/login','POST',{ email, password },previous);
  expect(response.status).toBe(200);
  return { cookie: response.headers.get('set-cookie')!.split(';')[0]!, session: authSessionSchema.parse(await response.json()), headers: response.headers };
}
async function queuedToken(userId: string, purpose: 'verify' | 'reset'): Promise<string> {
  const jobs = await db.collection<EmailJobRecord>('authEmailJobs').find({ userId, state: 'pending' }).sort({ createdAt: -1 }).toArray();
  for (const job of jobs) {
    const payload = JSON.parse(unseal(job.encryptedPayload!,config.AUTH_EMAIL_KEY)) as { text: string };
    const match = payload.text.match(new RegExp(`/${purpose}#token=([A-Za-z0-9_-]{43})`));
    if (match?.[1]) return match[1];
  }
  throw new Error('No matching durable email job');
}
beforeAll(async () => { await client.connect(); await migrateAuth(db); await migrateAuth(db); await auth.initialize(); server = await createApi(config); await server.app.listen(0,'127.0.0.1'); base = await server.app.getUrl(); });
afterAll(async () => { if (server) await server.close(); await auth.close(); await db.dropDatabase(); await client.close(); });

it('commits registration atomically, enforces unique identities and does not enumerate duplicates', async () => {
  const input = registerSchema.parse({ email: email('register'), username: `user_${randomUUID().slice(0,8)}`, displayName: 'Register', password });
  const first = await request('/auth/register','POST',input); const firstBody = await first.json();
  const second = await request('/auth/register','POST',input);
  expect(first.status).toBe(202); expect(second.status).toBe(202); expect(await second.json()).toEqual(firstBody);
  expect(await db.collection('users').countDocuments({ emailCanonical: input.email })).toBe(1);
  const stored = await db.collection<UserRecord>('users').findOne({ emailCanonical: input.email });
  expect(stored?.passwordHash).toMatch(/^\$argon2id\$/);
  expect(await db.collection('authTokens').countDocuments({ userId: stored!._id })).toBe(1);
  const job = await db.collection<EmailJobRecord>('authEmailJobs').findOne({ userId: stored!._id });
  expect(job?.encryptedPayload).not.toContain(input.email);
  await expect(db.collection<UserRecord>('users').insertOne({ ...stored!, _id: randomUUID() })).rejects.toMatchObject({ code: 11000 });
  await expect(db.collection<{_id:string;role:string}>('users').updateOne({ _id: stored!._id }, { $set: { role: 'administrator' } })).rejects.toMatchObject({ code: 121 });
});
it('rejects missing/forged origins, CSRF, attacker identity and guessed sessions', async () => {
  const input = await user('secure'); const signed = await login(input.email);
  expect(signed.headers.get('set-cookie')).toContain('HttpOnly'); expect(signed.headers.get('set-cookie')).toContain('SameSite=Lax');
  const raw = signed.cookie.split('=')[1]!; const stored = await db.collection<SessionRecord>('sessions').findOne({ tokenHash: tokenHash(raw) });
  expect(stored).not.toHaveProperty('token'); expect(stored?.tokenHash).not.toBe(raw);
  expect((await request('/auth/logout','POST',{},signed.cookie,undefined)).status).toBe(403);
  expect((await request('/auth/logout','POST',{},signed.cookie,signed.session.csrfToken,'https://evil.example.test')).status).toBe(403);
  expect((await request('/auth/login','POST',{ email: input.email,password },undefined,undefined,'')).status).toBe(403);
  expect((await request('/auth/login','POST',{ email: input.email,password,senderId: randomUUID() })).status).toBe(400);
  expect((await request(`/sessions/${randomUUID()}`,'DELETE',undefined,signed.cookie,signed.session.csrfToken)).status).toBe(403);
  expect((await request('/auth/session','GET',undefined,`commonroom_session=${'a'.repeat(43)}`)).status).toBe(401);
});
it('rejects non-JSON mutations and invalid payloads with safe errors', async () => {
  const response = await fetch(`${base}/api/v1/auth/register`, { method: 'POST', headers: { Origin: config.WEB_ORIGIN, 'Content-Type': 'text/plain' }, body: 'secret-synthetic' });
  expect(response.status).toBe(415); expect(await response.text()).not.toContain('secret-synthetic');
});
it('serializes session quota, rotates cookies, and rejects expired/revoked sessions without TTL cleanup', async () => {
  const input = await user('quota'); const first = await login(input.email); const rotated = await login(input.email,first.cookie);
  expect(rotated.cookie).not.toBe(first.cookie); expect((await request('/auth/session','GET',undefined,first.cookie)).status).toBe(401);
  const concurrent = await Promise.all([request('/auth/login','POST',{ email: input.email,password }),request('/auth/login','POST',{ email: input.email,password })]);
  expect(concurrent.map(response => response.status).sort()).toEqual([200,409]);
  await db.collection<SessionRecord>('sessions').updateOne({ _id: rotated.session.sessionId }, { $set: { expiresAt: new Date(0) } });
  expect((await request('/auth/session','GET',undefined,rotated.cookie)).status).toBe(401);
});
it('rejects another user’s session revocation and keeps privacy/profile changes authorized', async () => {
  const a = await user('alice'); const b = await user('bob'); const one = await login(a.email); const two = await login(b.email);
  expect((await request(`/sessions/${two.session.sessionId}`,'DELETE',undefined,one.cookie,one.session.csrfToken)).status).toBe(403);
  const changed = await request('/me','PATCH',{ username: a.username, displayName: 'A new name', privacy: { showPresence: false,allowSearch: false } },one.cookie,one.session.csrfToken);
  expect(changed.status).toBe(200); expect((await changed.json() as { privacy: unknown }).privacy).toEqual({ showPresence: false,allowSearch: false });
  const conflict = await request('/me','PATCH',{ username: b.username,displayName:'A',privacy:{showPresence:true,allowSearch:true} },one.cookie,one.session.csrfToken);
  expect(conflict.status).toBe(409);
});
it('uses verification/reset tokens once under concurrent requests and revokes all sessions on reset', async () => {
  const input = await user('reset'); const signed = await login(input.email); const id = signed.session.user.id;
  const verification = await queuedToken(id,'verify');
  const verify = await request('/auth/verify','POST',{ token: verification }); expect(verify.status).toBe(200);
  expect((await request('/auth/verify','POST',{token:verification})).status).toBe(400);
  expect((await request('/auth/session','GET',undefined,signed.cookie)).status).toBe(200);
  const existing = await request('/auth/reset/request','POST',{email:input.email}); const absent = await request('/auth/reset/request','POST',{email:email('absent')});
  expect(await absent.json()).toEqual(await existing.json());
  const token = await queuedToken(id,'reset');
  expect(await db.collection('authTokens').findOne({ userId:id, purpose:'reset' })).not.toHaveProperty('token');
  const results = await Promise.all([request('/auth/reset/confirm','POST',{token,password:'New-synthetic-password-456'}), request('/auth/reset/confirm','POST',{token,password:'New-synthetic-password-456'})]);
  expect(results.map(response => response.status).sort()).toEqual([200,400]);
  expect((await request('/auth/session','GET',undefined,signed.cookie)).status).toBe(401);
  expect((await request('/auth/login','POST',{email:input.email,password})).status).toBe(401);
  expect((await request('/auth/login','POST',{email:input.email,password:'New-synthetic-password-456'})).status).toBe(200);
});
it('enforces auth-token expiry on reads, without relying on TTL deletion', async () => {
  const input = await user('expiry'); const stored = await db.collection<UserRecord>('users').findOne({emailCanonical:input.email});
  const token = await queuedToken(stored!._id,'verify');
  await db.collection<TokenRecord>('authTokens').updateOne({ hash: tokenHash(token) },{$set:{ expiresAt:new Date(0) }});
  expect((await request('/auth/verify','POST',{token})).status).toBe(400);
});
it('resends verification for an authenticated account, invalidates the previous link, and serializes verification races', async () => {
  const input = await user('resend'); const signed = await login(input.email); const id = signed.session.user.id;
  const old = await queuedToken(id,'verify'); const raw = signed.cookie.split('=')[1]!;
  const principal = await auth.authenticate(raw);
  expect(() => requireVerified(principal)).toThrow();
  const response = await request('/auth/verify/request','POST',{},signed.cookie,signed.session.csrfToken);
  expect(response.status).toBe(202); const token = await queuedToken(id,'verify'); expect(token).not.toBe(old);
  expect((await request('/auth/verify','POST',{token:old})).status).toBe(400);
  const results = await Promise.all([request('/auth/verify','POST',{token}),request('/auth/verify','POST',{token})]);
  expect(results.map(item=>item.status).sort()).toEqual([200,400]);
  expect(() => requireVerified(principal)).toThrow(); // old in-memory principal cannot elevate itself
  const verified = await auth.authenticate(raw);
  expect(() => requireVerified(verified)).not.toThrow();
});
it('uses Secure host-only cookies when configured for HTTPS deployment', async () => {
  const secure = loadConfig({ ...process.env,NODE_ENV:'test', MONGODB_DATABASE:config.MONGODB_DATABASE,COOKIE_SECURE:'true' });
  const api = await createApi(secure); const input = await user('tlsflags');
  try {
    await api.app.listen(0,'127.0.0.1');
    const response = await fetch(`${await api.app.getUrl()}/api/v1/auth/login`, {method:'POST',headers:{Origin:config.WEB_ORIGIN,'Content-Type':'application/json'},body:JSON.stringify({email:input.email,password})});
    expect(response.status).toBe(200); const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toMatch(/^__Host-commonroom_session=/); expect(cookie).toContain('Secure'); expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Path=/'); expect(cookie).not.toContain('Domain=');
  } finally { await api.close(); }
});
it('password change and revoke-all invalidate every device and cannot preserve a stale principal', async () => {
  const input = await user('change'); const one = await login(input.email); const two = await login(input.email);
  expect((await request('/auth/password','POST',{currentPassword:password,password:'Changed-synthetic-password-456'},one.cookie,one.session.csrfToken)).status).toBe(200);
  expect((await request('/auth/session','GET',undefined,one.cookie)).status).toBe(401); expect((await request('/auth/session','GET',undefined,two.cookie)).status).toBe(401);
  const input2 = await user('revoke'); const device = await login(input2.email);
  expect((await request('/sessions/all','DELETE',undefined,device.cookie,device.session.csrfToken)).status).toBe(200);
  expect((await request('/auth/session','GET',undefined,device.cookie)).status).toBe(401);
});
it('fails security mutations closed on Redis failure, while preserving authenticated read access', async () => {
  const bad = loadConfig({ ...process.env,NODE_ENV:'test', MONGODB_DATABASE:config.MONGODB_DATABASE,REDIS_URL:'redis://127.0.0.1:1',DEPENDENCY_TIMEOUT_MS:'100' });
  const api = await createApi(bad); const input = await user('redis'); const signed = await login(input.email);
  try {
    await api.app.listen(0,'127.0.0.1'); const endpoint = await api.app.getUrl();
    expect((await fetch(`${endpoint}/api/v1/auth/session`,{headers:{Cookie:signed.cookie}})).status).toBe(200);
    const mutation = await fetch(`${endpoint}/api/v1/auth/logout`,{method:'POST',headers:{Origin:config.WEB_ORIGIN,'Content-Type':'application/json',Cookie:signed.cookie,'X-CSRF-Token':signed.session.csrfToken},body:'{}'});
    expect(mutation.status).toBe(503);
  } finally { await api.close(); }
});
it('enforces Redis auth limits atomically', async () => {
  const key = `rate-test:${randomUUID()}`;
  await auth.rates.consume(key,1,60); await expect(auth.rates.consume(key,1,60)).rejects.toMatchObject({status:429});
});
it('rerunning an applied migration does not overwrite a later additive validator', async () => {
  const input = await user('migration'); const stored = await db.collection<UserRecord>('users').findOne({emailCanonical:input.email});
  const collection = await db.listCollections({name:'users'}).next();
  if (!collection || !('options' in collection)) throw new Error('Missing collection validator');
  const validator = collection!.options!.validator!;
  validator['$jsonSchema'].properties['futureSetting'] = {bsonType:'bool'};
  await db.command({collMod:'users',validator}); await migrateAuth(db);
  await expect(db.collection<{_id:string;futureSetting?:boolean}>('users').updateOne({_id:stored!._id},{$set:{futureSetting:true}})).resolves.toMatchObject({modifiedCount:1});
});
it('sends real queued mail, recovers expired leases, and never completes provider failures', async () => {
  const input = await user('mail'); const stored = await db.collection<UserRecord>('users').findOne({emailCanonical:input.email});
  const jobs = db.collection<EmailJobRecord>('authEmailJobs'); const job = await jobs.findOne({userId:stored!._id});
  await jobs.updateMany({ _id: { $ne: job!._id },state:'pending' },{$set:{availableAt:new Date(Date.now()+3600000)}});
  await jobs.updateOne({_id:job!._id},{$set:{state:'sending',leaseOwner:'crashed-worker',leaseUntil:new Date(0)}});
  const worker = new AuthEmailWorker(db,config); expect(await worker.runOnce()).toBe(true);
  expect((await jobs.findOne({_id:job!._id}))?.state).toBe('sent'); expect((await jobs.findOne({_id:job!._id}))?.encryptedPayload).toBeNull();
  const mail = await fetch(`${mailpitOrigin}/api/v1/search?query=${encodeURIComponent(`to:${input.email}`)}`);
  expect((await mail.json() as { messages: unknown[] }).messages.length).toBeGreaterThan(0);
  const failedInput = await user('failmail'); const failedUser = await db.collection<UserRecord>('users').findOne({emailCanonical:failedInput.email});
  const failure = new AuthEmailWorker(db,config,{async send() { throw new Error('simulated SMTP refusal'); }});
  await failure.runOnce(); const failed = await jobs.findOne({userId:failedUser!._id});
  expect(failed?.state).toBe('pending'); expect(failed?.completedAt).toBeNull();
  await jobs.updateOne({_id:failed!._id},{$set:{state:'sending',attempts:5,leaseUntil:new Date(0)}}); await failure.runOnce();
  expect((await jobs.findOne({_id:failed!._id}))?.state).toBe('dead');
});
