import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { login, register, search } from './chat-fixture.js';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '@chat/config';
import { AuthService, SyncService, createMongoClient } from '@chat/domain';
import type { ReplayFloor } from '@chat/domain';
import { Long } from 'mongodb';

async function send(page: Page, text: string) {
  await page.getByLabel('Message', { exact: true }).fill(text);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
}
async function pending(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open('commonroom-sync-v1'); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try { return await new Promise<{ command: { type: string; body: { clientMessageId?: string; text?: string } }; state: string }[]>((resolve, reject) => { const request = db.transaction('pending').objectStore('pending').getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
    finally { db.close(); }
  });
}
test('live inbox discovery, edits, offline reaction repair, explicit reads and deletion converge between users', async ({ page, browser, request }) => {
  const alice = await register(request, 'livealice'), bob = await register(request, 'livebob'), context = await browser.newContext(), other = await context.newPage();
  try {
    await login(page, alice.email); await login(other, bob.email);
    await expect(other.getByText('Live connection', { exact: false })).toBeVisible();
    await search(page, bob.username); await page.getByRole('button', { name: `Open conversation with ${bob.username}`, exact: true }).click();
    await expect(other.locator('.inbox-link').filter({ hasText: 'livealice' })).toBeVisible({ timeout: 8000 });
    await other.locator('.inbox-link').filter({ hasText: 'livealice' }).click();
    await send(page, 'Live original'); await expect(other.locator('.message-list')).toContainText('Live original', { timeout: 8000 });
    await context.setOffline(true);
    await other.getByRole('button', { name: 'Like 0', exact: true }).click();
    await other.getByRole('button', { name: 'Mark messages read', exact: true }).click();
    await expect.poll(async () => (await pending(other)).some(row => row.command.type === 'mutation')).toBe(true);
    page.once('dialog', dialog => { void dialog.accept('Edited while the other device was offline'); });
    await page.getByRole('button', { name: 'Edit message', exact: true }).click();
    await expect(page.locator('.message-list')).toContainText('Edited while the other device was offline');
    await context.setOffline(false);
    await expect(other.locator('.message-list')).toContainText('Edited while the other device was offline', { timeout: 25000 });
    await expect(page.getByRole('button', { name: 'Like 1', exact: true })).toBeVisible({ timeout: 25000 });
    await expect(page.locator('.message-list small').getByText('Read', { exact: true })).toBeVisible({ timeout: 25000 });
    await context.setOffline(true);
    page.once('dialog', dialog => { void dialog.accept(); }); await page.getByRole('button', { name: 'Delete message', exact: true }).click();
    await expect(page.locator('.message-list')).toContainText('Message deleted'); await context.setOffline(false);
    await expect(other.locator('.message-list')).toContainText('Message deleted', { timeout: 25000 });
    await page.screenshot({ path: '.cache/qa/sync-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.cache/qa/sync-mobile.png', fullPage: true });
  } finally { await context.setOffline(false); await context.close(); }
});

test('offline commands survive reload, two tabs reuse one command and logout purges private stores', async ({ page, request }) => {
  const actor = await register(request, 'offlineuser'); await login(page, actor.email);
  await page.getByLabel('Group name', { exact: true }).fill('Offline queue'); await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible(); const url = page.url();
  let blocked = true; const transmitted: string[] = [];
  await page.context().route('**/api/v1/messages', async route => { if (blocked) { await route.abort('failed'); return; } transmitted.push((route.request().postDataJSON() as { clientMessageId: string }).clientMessageId); await route.continue(); });
  await page.context().setOffline(true); await send(page, 'Survives refresh exactly once');
  let commandId = '';
  await expect.poll(async () => { const row = (await pending(page)).find(row => row.command.type === 'send'); commandId = row?.command.body.clientMessageId ?? ''; return commandId.length; }).toBe(36);
  await page.context().setOffline(false); await page.reload();
  await expect(page.getByLabel('Pending commands')).toContainText('Survives refresh exactly once');
  const second = await page.context().newPage(); await second.goto(url); await expect(second.getByLabel('Pending commands')).toContainText('Survives refresh exactly once');
  expect((await pending(second)).find(row => row.command.type === 'send')?.command.body.clientMessageId).toBe(commandId);
  blocked = false;
  await expect(page.locator('.message-list li').filter({ hasText: 'Survives refresh exactly once' })).toHaveCount(1, { timeout: 40000 });
  await expect(second.locator('.message-list li').filter({ hasText: 'Survives refresh exactly once' })).toHaveCount(1, { timeout: 25000 });
  expect(transmitted.length).toBeGreaterThan(0); expect(new Set(transmitted)).toEqual(new Set([commandId]));
  await expect.poll(async () => (await pending(page)).filter(row => row.command.type === 'send').length).toBe(0);
  await page.context().unroute('**/api/v1/messages');
  // Delay one real snapshot while another tab persists a newer projection.
  let release!: () => void, captured!: () => void, intercept = true;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { captured = resolve; });
  await page.route('**/api/v1/sync/conversations/*/snapshot', async route => { if (!intercept) { await route.continue(); return; } intercept = false; const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); });
  try {
    await page.reload(); await ready;
    await send(second, 'A newer projection from another tab'); await expect(second.locator('.message-list')).toContainText('A newer projection from another tab');
    release(); await expect(page.locator('.message-list')).toContainText('A newer projection from another tab');
  } finally { release(); await page.unroute('**/api/v1/sync/conversations/*/snapshot'); }
  await page.getByRole('link', { name: 'Account & privacy' }).click(); await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect.poll(async () => (await pending(second)).length).toBe(0); await expect(second).toHaveURL(/\/login$/);
  await expect.poll(async () => second.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const request = indexedDB.open('commonroom-sync-v1'); request.onsuccess = () => resolve(request.result); });
    try { return await Promise.all(['pending', 'projections', 'inbox'].map(name => new Promise<number>(resolve => { const request = db.transaction(name).objectStore(name).count(); request.onsuccess = () => resolve(request.result); }))); }
    finally { db.close(); }
  })).toEqual([0, 0, 0]);
  const nextAccount = await register(request, 'switchuser'); await login(page, nextAccount.email);
  await expect(page.locator('.inbox-list')).not.toContainText('Offline queue');
  await second.goto(url); await expect(second.getByRole('heading', { name: 'Conversation unavailable', exact: true })).toBeVisible();
  await expect(second.getByText('Survives refresh exactly once', { exact: true })).toHaveCount(0); expect(await pending(second)).toHaveLength(0);
});

test('older history replaces the bounded window and an expired replay cursor resets from an authorized snapshot', async ({ page, request }) => {
  const actor = await register(request, 'historywindow'); await login(page, actor.email);
  await page.getByLabel('Group name', { exact: true }).fill('History windows'); await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible(); const id = page.url().split('/').at(-1)!;
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: process.env['E2E_DATABASE']! }), client = createMongoClient(config), auth = new AuthService(config, client, client.db(config.MONGODB_DATABASE)), service = new SyncService(auth);
  const token = (await page.context().cookies()).find(cookie => cookie.name === 'commonroom_session')!.value;
  try {
    await client.connect(); await auth.initialize();
    for (let index = 0; index < 103; index++) await service.send(token, { v: 1, conversationId: id, clientMessageId: randomUUID(), text: `History item ${index}`, attachmentIds: [] });
    await expect(page.locator('.message-list li')).toHaveCount(100, { timeout: 25000 }); await expect(page.locator('.message-list')).toContainText('History item 102', { timeout: 25000 });
    await page.getByRole('button', { name: 'Earlier messages', exact: true }).click(); await expect(page.locator('.message-list li')).toHaveCount(3);
    await page.getByRole('button', { name: 'Latest messages', exact: true }).click(); await expect(page.locator('.message-list li')).toHaveCount(100);
    let expired = 0; page.on('response', response => { if (response.url().includes('/events?after=') && response.status() === 409) expired++; });
    // An already-running snapshot can legitimately skip expired replay by recovering first.
    // Hold that recovery path until the engine observes a real server CURSOR_EXPIRED.
    await page.route(`**/sync/conversations/${id}/snapshot`, route => expired ? route.continue() : route.abort('failed'));
    await page.context().setOffline(true);
    const sent = await service.send(token, { v: 1, conversationId: id, clientMessageId: randomUUID(), text: 'After the replay retention floor', attachmentIds: [] });
    await client.db(config.MONGODB_DATABASE).collection<ReplayFloor>('replayFloors').insertOne({ _id: id, schemaVersion: 1, floor: Long.fromString(sent.message.creationSequence), createdAt: new Date() });
    await page.context().setOffline(false); await expect.poll(() => expired, { timeout: 25000 }).toBeGreaterThan(0);
    await expect(page.locator('.message-list')).toContainText('After the replay retention floor', { timeout: 25000 }); await expect(page.locator('.message-list li')).toHaveCount(100);
  } finally { await page.context().setOffline(false); await auth.close(); await client.close(); }
});

test('storage denial discloses memory-only pending commands', async ({ page, request }) => {
  const actor = await register(request, 'nostorage');
  await page.addInitScript(() => { Object.defineProperty(window, 'indexedDB', { get() { throw new DOMException('Storage disabled', 'SecurityError'); } }); });
  await login(page, actor.email); await expect(page.getByText('Storage unavailable: pending commands stay only in this page', { exact: false })).toBeVisible();
  await page.getByLabel('Group name', { exact: true }).fill('Memory queue'); await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await page.route('**/api/v1/messages', route => route.abort('failed')); await send(page, 'Only in this page');
  await expect(page.getByLabel('Pending commands')).toContainText('Only in this page');
  await expect(page.locator('.composer')).toContainText('Refreshing can discard unconfirmed commands');
  await page.reload(); await expect(page.getByLabel('Message', { exact: true })).toBeVisible(); await expect(page.getByLabel('Pending commands')).toHaveCount(0);
});

test('repairs deliberately lost Redis publications while the recipient socket stays connected', async ({ page, browser, request }) => {
  const alice = await register(request, 'gapalice'), bob = await register(request, 'gapbob'), context = await browser.newContext(), other = await context.newPage();
  let closed = 0; other.on('websocket', socket => socket.on('close', () => { closed++; }));
  try {
    await login(page, alice.email); await login(other, bob.email); await search(page, bob.username);
    await page.getByRole('button', { name: `Open conversation with ${bob.username}`, exact: true }).click();
    await other.locator('.inbox-link').filter({ hasText: 'gapalice' }).click();
    await expect(other.getByText('Live connection', { exact: false })).toBeVisible();
    const baseline = closed, before = await (await request.get('http://127.0.0.1:16381/health')).json() as { suppressed: number };
    expect((await request.post('http://127.0.0.1:16381/drop')).ok()).toBe(true);
    await send(page, 'Recovered despite a lost Redis publication');
    await expect(other.locator('.message-list')).toContainText('Recovered despite a lost Redis publication', { timeout: 25000 });
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:16381/health')).json() as { suppressed: number }).suppressed, { timeout: 30000 }).toBeGreaterThan(before.suppressed); expect(closed).toBe(baseline);
    await expect(other.getByText('Live connection', { exact: false })).toBeVisible();
  } finally { await request.post('http://127.0.0.1:16381/pass'); await context.close(); }
});

test('a real live burst overflows the client hint buffer and recovers without advancing past unapplied state', async ({ page, request }) => {
  const actor = await register(request, 'overflowuser'); let stalled = false, frames = 0, overflowClosed = false;
  page.on('websocket', socket => { socket.on('framereceived', event => { if (stalled && String(event.payload).includes('sync:hint')) frames++; }); socket.on('close', () => { if (stalled && frames >= 9) overflowClosed = true; }); });
  await login(page, actor.email); await page.getByLabel('Group name', { exact: true }).fill('Overflow recovery'); await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible(); const id = page.url().split('/').at(-1)!;
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: process.env['E2E_DATABASE']! }), client = createMongoClient(config), auth = new AuthService(config, client, client.db(config.MONGODB_DATABASE)), service = new SyncService(auth);
  const token = (await page.context().cookies()).find(cookie => cookie.name === 'commonroom_session')!.value;
  let release!: () => void, captured!: () => void, intercept = true;
  const held = new Promise<void>(resolve => { release = resolve; }), ready = new Promise<void>(resolve => { captured = resolve; });
  await page.route('**/api/v1/sync/conversations/*/snapshot', async route => { if (!intercept) { await route.continue(); return; } intercept = false; const response = await route.fetch(); captured(); await held; await route.fulfill({ response }); });
  let producing: Promise<void> | undefined;
  try {
    await client.connect(); await auth.initialize(); stalled = true;
    await service.send(token, { v: 1, conversationId: id, clientMessageId: randomUUID(), text: 'Start held recovery', attachmentIds: [] }); await ready;
    producing = (async () => { for (let index = 0; index < 24; index++) await service.send(token, { v: 1, conversationId: id, clientMessageId: randomUUID(), text: `Burst item ${index}`, attachmentIds: [] }); })(); void producing.catch(() => {});
    await expect.poll(() => overflowClosed, { timeout: 12000 }).toBe(true);
    release(); stalled = false; await producing; await expect(page.locator('.message-list')).toContainText('Burst item 23', { timeout: 25000 }); await expect(page.locator('.message-list li')).toHaveCount(25);
    await expect(page.getByText('Live connection', { exact: false })).toBeVisible({ timeout: 10000 });
  } finally { release(); stalled = false; await producing?.catch(() => {}); await page.unroute('**/api/v1/sync/conversations/*/snapshot'); await auth.close(); await client.close(); }
});
