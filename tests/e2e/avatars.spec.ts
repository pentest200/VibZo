import { test, expect } from '@playwright/test';
import { login, register, search } from './chat-fixture.js';
import { png } from '../fixtures/png.js';

test('two users upload checked private avatars, opt in, revoke, replace and remove through visible controls', async ({ page, browser, request }) => {
  const alice = await register(request, 'avatarowner'), bob = await register(request, 'avatarpeer'), context = await browser.newContext(), other = await context.newPage();
  try {
    await login(page, alice.email); await login(other, bob.email); await search(page, bob.username);
    await page.getByRole('button', { name: `Open conversation with ${bob.username}`, exact: true }).click();
    await expect(page).toHaveURL(/\/chat\/[a-f0-9-]{36}$/); const conversation = page.url().split('/').at(-1)!;
    await other.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await other.locator('.inbox-link').filter({ hasText: 'avatarowner' }).click();
    await page.goto('/account');
    const account = await (await page.request.get('/api/v1/auth/session')).json() as { user: { id: string }; csrfToken: string };
    const peer = await (await other.request.get('/api/v1/auth/session')).json() as { csrfToken: string };
    const access = () => other.request.post(`/api/v1/avatars/${account.user.id}/download`, { headers: { Origin: 'http://localhost:5173', 'X-CSRF-Token': peer.csrfToken }, data: { conversationId: conversation } });
    const panel = page.getByRole('region', { name: 'Avatar settings', exact: true });
    const sharing = panel.getByRole('checkbox', { name: 'Share my avatar with active conversation members', exact: true });
    async function share(value: boolean) {
      const saved = page.waitForResponse(response => response.url().endsWith('/api/v1/avatars/privacy') && response.status() === 200);
      if (value) await sharing.check(); else await sharing.uncheck();
      await saved; await expect(panel.getByRole('status').filter({ hasText: 'Avatar settings saved.' })).toBeVisible();
      if (value) await expect(sharing).toBeChecked(); else await expect(sharing).not.toBeChecked();
    }
    await expect(sharing).not.toBeChecked();
    await panel.getByLabel('Upload avatar', { exact: true }).setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: png() });
    await expect(panel).toContainText('Ready to use', { timeout: 45000 }); await panel.getByRole('button', { name: 'Use as avatar', exact: true }).click();
    const preview = panel.getByRole('img', { name: "avatarowner's avatar", exact: true });
    await expect(preview).toBeVisible(); await expect.poll(() => preview.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect((await access()).status()).toBe(403);
    await share(true);
    const received = other.locator('.conversation-heading').getByRole('img', { name: "avatarowner's avatar", exact: true });
    await expect(received).toBeVisible({ timeout: 25000 }); await expect.poll(() => received.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
    expect((await access()).status()).toBe(200);
    await share(false); expect((await access()).status()).toBe(403);
    await expect(received).toHaveCount(0, { timeout: 25000 });
    await share(true); await expect(received).toBeVisible({ timeout: 25000 });
    const previous = await preview.getAttribute('src');
    await panel.getByLabel('Upload avatar', { exact: true }).setInputFiles({ name: 'replacement.png', mimeType: 'image/png', buffer: png(24, 24) });
    await expect(panel).toContainText('Ready to use', { timeout: 45000 }); await panel.getByRole('button', { name: 'Use as avatar', exact: true }).click();
    await expect.poll(() => preview.getAttribute('src')).not.toBe(previous); await expect.poll(() => preview.evaluate(node => (node as HTMLImageElement).naturalWidth)).toBe(24);
    await expect.poll(() => received.evaluate(node => (node as HTMLImageElement).naturalWidth), { timeout: 25000 }).toBe(24);
    await page.screenshot({ path: '.cache/qa/avatars-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); await expect(panel.getByLabel('Upload avatar', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.screenshot({ path: '.cache/qa/avatars-mobile.png', fullPage: true });
    await panel.getByRole('button', { name: 'Remove current avatar', exact: true }).click(); await expect(preview).toHaveCount(0); expect((await access()).status()).toBe(403);
    await expect(received).toHaveCount(0, { timeout: 25000 });
    await panel.getByLabel('Upload avatar', { exact: true }).setInputFiles({ name: 'spoof.png', mimeType: 'image/png', buffer: Buffer.from('Not a real image') });
    await expect(panel.locator('.avatar-candidates li').filter({ hasText: 'spoof.png' })).toContainText(/signature|type|rejected/i, { timeout: 30000 });
    await expect(panel.getByRole('button', { name: 'Use as avatar', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click(); await expect(page).toHaveURL(/\/login$/);
    await login(page, bob.email); await page.goto('/account');
    const switched = page.getByRole('region', { name: 'Avatar settings', exact: true });
    await expect(switched.getByLabel('Upload avatar', { exact: true })).toBeVisible();
    await expect(switched.locator('.avatar-candidates li')).toHaveCount(0);
    await expect(switched.getByRole('checkbox', { name: 'Share my avatar with active conversation members', exact: true })).not.toBeChecked();
    await expect(switched.getByRole('img')).toHaveCount(0);
  } finally { await context.close(); }
});
