import { test, expect } from '@playwright/test';
import { register, login, search } from './chat-fixture.js';
import { accessible, reflow } from './accessibility.js';

test('messaging workspace supports keyboard send, emoji, filters, theme, details and mobile navigation with real users', async ({ page, browser, request }, info) => {
  const alex = await register(request, 'alex'), maya = await register(request, 'maya');
  const context = await browser.newContext(), other = await context.newPage();
  try {
    await login(page, alex.email); await login(other, maya.email);
    await page.getByRole('button', { name: 'New message', exact: true }).click(); await expect(page.getByLabel('Username prefix')).toBeFocused(); await page.getByRole('button', { name: 'Back to conversations', exact: true }).click();
    await search(page, maya.username); await page.getByRole('button', { name: `Open conversation with ${maya.username}`, exact: true }).click();
    const message = page.getByLabel('Message', { exact: true });
    await message.fill('Hey Maya!'); await message.press('Shift+Enter'); await expect(message).toHaveValue('Hey Maya!\n'); await message.press('End'); await message.press('Enter');
    await expect(page.locator('.message-list')).toContainText('Hey Maya!');
    await page.getByRole('button', { name: 'Choose emoji', exact: true }).click(); await page.getByRole('button', { name: 'Insert 👋', exact: true }).click();
    await expect(message).toHaveValue('👋'); await message.press('Enter'); await expect(page.locator('.message-list')).toContainText('👋');
    await other.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await other.locator('.inbox-link').filter({ hasText: 'alex' }).click();
    await other.getByLabel('Message', { exact: true }).fill('Hi Alex! Great to see you here.'); await other.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.message-list')).toContainText('Great to see you here.', { timeout: 20000 });
    const own = page.locator('.message-list > li.message').filter({ hasText: 'Hey Maya!' }).first(); await own.focus(); await page.keyboard.press('Tab'); await expect(own.getByRole('button', { name: /^Reply to/ })).toBeFocused(); await page.keyboard.press('Enter'); await expect(page.locator('.reply-preview')).toContainText('Hey Maya!'); await page.getByRole('button', { name: 'Cancel reply', exact: true }).click();
    await page.getByRole('button', { name: 'Conversation info', exact: true }).click(); await expect(page.getByRole('complementary', { name: 'Conversation details' })).toBeVisible();
    await page.getByRole('button', { name: 'Close conversation info', exact: true }).click();
    await page.getByRole('button', { name: 'Choose emoji', exact: true }).click(); await page.keyboard.press('Escape'); await expect(page.getByRole('group', { name: 'Emoji', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Attach files', exact: true }).click(); await expect(page.getByLabel('Attach a file', { exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.getByLabel('Attach a file', { exact: true })).not.toBeVisible();
    await accessible(page, info, 'workspace-light'); await page.screenshot({ path: '.cache/qa/telegram-chat-desktop.png' });
    await page.locator('.main-menu > summary').click(); await page.getByRole('button', { name: 'Night mode' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    if (await page.getByRole('button', { name: 'Night mode' }).isVisible()) await page.locator('.main-menu > summary').click();
    await accessible(page, info, 'workspace-dark'); await page.screenshot({ path: '.cache/qa/telegram-chat-dark.png' });
    await page.reload(); await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark'); await expect(message).toBeVisible(); expect(await page.evaluate(() => Object.keys(localStorage))).toEqual(['commonroom:appearance:v1']);
    await page.locator('.main-menu > summary').click(); await page.getByRole('button', { name: 'Night mode' }).click();
    if (await page.getByRole('button', { name: 'Night mode' }).isVisible()) await page.locator('.main-menu > summary').click();
    await page.locator('.main-menu > summary').click(); await page.keyboard.press('Escape'); await expect(page.getByRole('navigation', { name: 'Main menu', exact: true })).not.toBeVisible();
    await page.getByRole('button', { name: 'Mark messages read', exact: true }).click();
    await page.getByRole('button', { name: /^Unread/ }).click(); await expect(page.getByRole('button', { name: /^Unread/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'All chats', exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 }); await reflow(page); await expect(page.locator('.chat-sidebar')).not.toBeVisible(); await expect(message).toBeVisible();
    await accessible(page, info, 'workspace-mobile'); await page.screenshot({ path: '.cache/qa/telegram-chat-mobile.png' });
    await page.getByRole('link', { name: 'Back to conversations', exact: true }).click(); await expect(page.locator('.chat-sidebar')).toBeVisible(); await expect(page.locator('.chat-main')).not.toBeVisible();
    await page.locator('.inbox-link').filter({ hasText: 'maya' }).click(); await expect(message).toBeVisible();
    await page.getByRole('button', { name: 'Conversation info', exact: true }).click(); await expect(page.getByRole('complementary', { name: 'Conversation details' })).toBeVisible();
    await page.getByRole('button', { name: 'Close conversation info', exact: true }).click(); await expect(message).toBeVisible();
    await page.setViewportSize({ width: 320, height: 760 }); await page.getByRole('button', { name: 'Conversation info', exact: true }).click(); await expect(page.getByRole('button', { name: 'Block contact', exact: true })).toBeVisible(); await reflow(page); await accessible(page, info, 'details-320'); await page.screenshot({ path: '.cache/qa/telegram-details-mobile.png' }); await page.getByRole('button', { name: 'Close conversation info', exact: true }).click();
  } finally { await context.close(); }
});
