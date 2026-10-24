import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { login, register, search } from './chat-fixture.js';
test('two browsers upload, scan, send and download private files, recover staged files and show rejection', async ({ page, browser, request }) => {
  const alice = await register(request, 'file_sender'), bob = await register(request, 'file_receiver'), context = await browser.newContext(), other = await context.newPage();
  const content = Buffer.from('Browser attachment bytes, scanned and sent.\n');
  try {
    await login(page, alice.email); await login(other, bob.email); await search(page, bob.username); await page.getByRole('button', { name: `Open conversation with ${bob.username}`, exact: true }).click();
    await page.getByRole('button', { name: 'Attach files', exact: true }).click(); await page.getByLabel('Attach a file', { exact: true }).setInputFiles({ name: 'browser-notes.txt', mimeType: 'text/plain', buffer: content });
    await expect(page.locator('.attachment-picker')).toContainText('Ready to send', { timeout: 45000 });
    await page.reload(); await page.getByRole('button', { name: 'Attach files', exact: true }).click(); await expect(page.getByRole('checkbox', { name: 'browser-notes.txt', exact: true })).toBeEnabled();
    await page.getByRole('checkbox', { name: 'browser-notes.txt', exact: true }).check();
    await page.getByRole('button', { name: 'Send message', exact: true }).click(); await expect(page.locator('.message-list')).toContainText('Download browser-notes.txt');
    await other.getByRole('button', { name: 'Refresh inbox' }).click(); await other.locator('.inbox-link').filter({ hasText: 'file_sender' }).click();
    const result = other.waitForEvent('download'); await other.getByRole('button', { name: 'Download browser-notes.txt', exact: true }).click(); const download = await result;
    expect(download.suggestedFilename()).toBe('browser-notes.txt'); expect(await readFile((await download.path())!)).toEqual(content);
    await page.getByRole('button', { name: 'Attach files', exact: true }).click(); await page.getByLabel('Attach a file', { exact: true }).setInputFiles({ name: 'active.txt', mimeType: 'text/plain', buffer: Buffer.from('<html>active content</html>') });
    await expect(page.locator('.attachment-picker')).toContainText('File rejected', { timeout: 30000 }); await expect(page.getByRole('checkbox', { name: 'active.txt', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Remove active.txt', exact: true }).click(); await expect(page.locator('.attachment-picker')).toContainText('Removing file');
    await page.screenshot({ path: '.cache/qa/attachments-desktop.png', fullPage: true }); await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByLabel('Attach a file', { exact: true })).toBeVisible(); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.cache/qa/attachments-mobile.png', fullPage: true });
  } finally { await context.close(); }
});
