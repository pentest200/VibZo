import { browserEndpoints } from './endpoints.js';
import { test, expect } from '@playwright/test';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { loadConfig } from '@chat/config';
import { createMongoClient } from '@chat/domain';
import type { UserRecord } from '@chat/domain';
import { login, register, search, messageActions } from './chat-fixture.js';
test('two users report, a protected moderator removes the reference, and deletion clears all sessions', async ({ page, browser, request }) => {
  const alice = await register(request, 'safetyalice'), bob = await register(request, 'safetybob'), mod = await register(request, 'safetymod');
  const name = process.env['E2E_DATABASE']; if (!name?.startsWith('chat_e2e_auth_')) throw new Error('Isolated database required');
  const mongo = createMongoClient(loadConfig({ ...process.env, MONGODB_DATABASE: name }));
  try { await mongo.connect(); await mongo.db(name).collection<UserRecord>('users').updateOne({ emailCanonical: mod.email }, { $set: { role: 'moderator' } }); } finally { await mongo.close(); }
  const context = await browser.newContext(), other = await context.newPage(), moderatorContext = await browser.newContext(), moderator = await moderatorContext.newPage(), secondContext = await browser.newContext(), second = await secondContext.newPage();
  try {
    await login(page, alice.email); await login(other, bob.email); await login(moderator, mod.email); await login(second, alice.email);
    await search(page, bob.username); await page.getByRole('button', { name: `Open conversation with ${bob.username}`, exact: true }).click();
    await page.getByLabel('Message', { exact: true }).fill('Please review this specific message.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.message-list')).toContainText('Please review this specific message.'); const url = page.url();
    await other.goto(url); await expect(other.locator('.message-list')).toContainText('Please review this specific message.', { timeout: 25000 });
    await messageActions(other); await other.getByRole('button', { name: 'Report message', exact: true }).click(); await other.getByLabel('Report reason').selectOption('harassment'); await other.getByRole('button', { name: 'Submit report', exact: true }).click();
    await expect(other.getByRole('status').filter({ hasText: 'Report submitted for review.' })).toBeVisible();
    await moderator.goto('/account'); await expect(moderator.getByLabel('Moderation reports')).toContainText('harassment');
    await moderator.getByRole('button', { name: 'Remove reported message', exact: true }).click();
    await expect(other.locator('.message-list')).toContainText('Message deleted', { timeout: 25000 });
    await page.getByLabel('Message', { exact: true }).fill('Delete my own remaining content.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(other.locator('.message-list')).toContainText('Delete my own remaining content.', { timeout: 25000 });
    await second.goto(url); await expect(second.locator('.message-list')).toContainText('Delete my own remaining content.', { timeout: 25000 });
    await page.goto('/account'); await expect(page.getByLabel('Moderation reports')).toHaveCount(0);
    await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
    await page.getByLabel('Confirm deletion password').fill('Conversation-browser-password-123'); await page.getByLabel('Type DELETE to confirm').fill('DELETE');
    await page.getByRole('button', { name: 'Permanently delete account', exact: true }).click(); await expect(page).toHaveURL(/\/login$/);
    await expect(other.locator('.message-list')).not.toContainText('Delete my own remaining content.', { timeout: 25000 });
    await second.goto('/account'); await expect(second).toHaveURL(/\/login$/);
    for (const current of [page, second]) {
      expect((await current.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => { const open = indexedDB.open('commonroom-sync-v1'); open.onsuccess = () => resolve(open.result); open.onerror = () => reject(open.error); });
        try { return await Promise.all([...db.objectStoreNames].map(name => new Promise<number>((resolve, reject) => { const count = db.transaction(name).objectStore(name).count(); count.onsuccess = () => resolve(count.result); count.onerror = () => reject(count.error); }))); } finally { db.close(); }
      })).every(count => count === 0)).toBe(true);
    }
  } finally { await context.close(); await moderatorContext.close(); await secondContext.close(); }
});
test('explicit browser permission denial preserves the in-app unread fallback without subscribing', async ({ page, context, request }) => {
  const user = await register(request, 'deniedpush'); await login(page, user.email); await page.goto('/account');
  const devtools = await context.newCDPSession(page);
  const { targetInfo } = await devtools.send('Target.getTargetInfo');
  if (!targetInfo.browserContextId) throw new Error('An isolated browser context is required');
  await devtools.send('Browser.setPermission', { browserContextId: targetInfo.browserContextId, permission: { name: 'notifications' }, setting: 'denied', origin: browserEndpoints().origin });
  expect(await page.evaluate(() => Notification.permission)).toBe('denied');
  let subscriptions = 0; page.on('request', request => { if (request.url().endsWith('/safety/subscriptions') && request.method() === 'POST') subscriptions++; });
  await page.getByRole('button', { name: 'Enable notifications on this device', exact: true }).click();
  await expect(page.getByLabel('Notification settings')).toContainText('Notifications were not allowed.');
  expect(subscriptions).toBe(0); await expect(page.getByRole('link', { name: 'Open conversations' })).toBeVisible();
  await page.getByRole('button', { name: 'Allow account notifications', exact: true }).click(); await expect(page.getByLabel('Notification settings')).toContainText('Account notifications are on.');
  await page.getByRole('button', { name: 'Pause account notifications', exact: true }).click(); await expect(page.getByLabel('Notification settings')).toContainText('Account notifications are off.');
  await page.getByLabel('Notification settings').screenshot({ path: '.cache/qa/safety-notifications-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByLabel('Notification settings').screenshot({ path: '.cache/qa/safety-notifications-mobile.png' });
});
test('unsupported push shows an actionable in-app fallback', async ({ page, request }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'PushManager', { value: undefined, configurable: true }); });
  const user = await register(request, 'unsupported'); await login(page, user.email); await page.goto('/account');
  await expect(page.getByLabel('Notification settings')).toContainText('Background notifications are unsupported here.');
  await expect(page.getByRole('button', { name: 'Enable notifications on this device', exact: true })).toBeDisabled();
});
test('local permission/subscription fixture verifies opt-in, real service-worker registration and device disable', async ({ page, request }) => {
  // Positive permission and push-service enrollment are explicit local fixtures.
  // This host reports native denial even after a context permission grant; native opt-in is unverified.
  // All application API persistence, CSRF checks and the service worker are real.
  const key = createECDH('prime256v1'); key.generateKeys();
  const fixture = { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, expirationTime: null, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  await page.addInitScript(value => {
    Object.defineProperty(Notification, 'requestPermission', { value: async () => 'granted' });
    let current: { toJSON(): typeof value; unsubscribe(): Promise<boolean> } | null = null;
    Object.defineProperty(PushManager.prototype, 'subscribe', { value: async () => { current = { toJSON: () => value, unsubscribe: async () => { current = null; return true; } }; return current; } });
    Object.defineProperty(PushManager.prototype, 'getSubscription', { value: async () => current });
  }, fixture);
  const user = await register(request, 'pushfixture'); await login(page, user.email); await page.goto('/account');
  await page.getByRole('button', { name: 'Enable notifications on this device', exact: true }).click();
  await expect(page.getByLabel('Notification settings')).toContainText('This device is subscribed.');
  expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.active?.scriptURL)).toContain('/notifications-sw.js');
  await page.getByRole('button', { name: 'Disable notifications on this device', exact: true }).click();
  await expect(page.getByLabel('Notification settings')).toContainText('This device is not subscribed.');
});
