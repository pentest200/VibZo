import { test, expect } from '@playwright/test';
import { login, register, search } from './chat-fixture.js';
test('two real users send, reply, reconcile a lost acceptance response and retain history after reload', async ({ page, browser, request }) => {
  const alice = await register(request, 'sender'), bob = await register(request, 'receiver'), context = await browser.newContext(), other = await context.newPage();
  try {
    await login(page, alice.email); await login(other, bob.email);
    await search(page, bob.username); await page.getByRole('button', { name: `Open conversation with ${bob.username}`, exact: true }).click();
    await expect(page.getByLabel('Message', { exact: true })).toBeVisible(); const url = page.url();
    await page.getByLabel('Message', { exact: true }).fill('Hello from a durable send.'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.composer')).toContainText('Accepted by the server'); await expect(page.locator('.message-list')).toContainText('Hello from a durable send.');
    await other.getByRole('button', { name: 'Refresh inbox' }).click(); await other.locator('.inbox-link').filter({ hasText: 'sender' }).click();
    await expect(other.locator('.message-list')).toContainText('Hello from a durable send.');
    await other.getByRole('button', { name: 'Reply to Hello from a durable send.' }).click(); await other.getByLabel('Message', { exact: true }).fill('A real reply.');
    await other.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page.locator('.message-list')).toContainText('A real reply.', { timeout: 15000 });
    let commandId = '', lost = false;
    await page.route('**/api/v1/messages', async route => {
      const body = route.request().postDataJSON() as { clientMessageId: string };
      if (!lost) { commandId = body.clientMessageId; lost = true; await route.fetch(); await route.abort('failed'); }
      else { expect(body.clientMessageId).toBe(commandId); await route.continue(); }
    });
    await page.getByLabel('Message', { exact: true }).fill('Exactly one stored command after a lost reply.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page.locator('.composer')).toContainText('original IDs');
    await expect(page.locator('.composer')).toContainText('Accepted by the server');
    await expect(page.locator('.message-list li').filter({ hasText: 'Exactly one stored command after a lost reply.' })).toHaveCount(1);
    await page.reload(); await expect(page.locator('.message-list li')).toHaveCount(3);
    await expect(page.locator('.message-list')).toContainText('A real reply.');
    await page.screenshot({ path: '.cache/qa/messaging-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.cache/qa/messaging-mobile.png', fullPage: true });
    await other.goto(url); await expect(other.locator('.message-list li')).toHaveCount(3);
    await expect.poll(async () => (await request.get('http://127.0.0.1:3002/health/ready')).status()).toBe(200);
    await expect.poll(async () => (await (await request.get('http://127.0.0.1:3002/metrics')).text()).includes('chat_outbox_pending 0\n')).toBe(true);
    const metrics = await (await request.get('http://127.0.0.1:3002/metrics')).text();
    expect(Number(metrics.match(/chat_outbox_publications_total (\d+)/)?.[1] ?? '0')).toBeGreaterThan(0);
  } finally { await context.close(); }
});
