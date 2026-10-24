import { test, expect } from '@playwright/test';
import { register, login, search, messageActions } from './chat-fixture.js';
import { accessible, reflow } from './accessibility.js';

test('delete choices, shared pins, private chat preferences, splitter and full emoji search persist with real users', async ({ page, browser, request }, info) => {
  const a = await register(request, 'interactiona'), b = await register(request, 'interactionb'), context = await browser.newContext(), other = await context.newPage();
  let nativeDialogs = 0; page.on('dialog', dialog => { nativeDialogs++; void dialog.dismiss(); });
  try {
    await login(page, a.email); await login(other, b.email); await search(page, b.username); await page.getByRole('button', { name: `Open conversation with ${b.username}`, exact: true }).click();
    const input = page.getByLabel('Message', { exact: true }); await input.fill('Keep the other copy'); await input.press('Enter');
    await other.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await other.locator('.inbox-link').filter({ hasText: 'interactiona' }).click(); await expect(other.locator('.message-list')).toContainText('Keep the other copy');
    await messageActions(page, 'Keep the other copy'); await page.getByRole('button', { name: 'Pin message', exact: true }).click(); await expect(other.locator('.pinned-message-bar')).toContainText('Keep the other copy', { timeout: 20000 });
    await page.getByRole('button', { name: 'Delete message', exact: true }).click(); const deletion = page.getByRole('dialog', { name: 'Delete message', exact: true }); await expect(deletion.getByRole('button', { name: 'Delete for me', exact: true })).toBeVisible(); await expect(deletion.getByRole('button', { name: 'Delete for everyone', exact: true })).toBeVisible();
    await accessible(page, info, 'delete-message-options'); await page.screenshot({ path: '.cache/qa/delete-message-choices.png' }); await deletion.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.locator('.message-list')).toContainText('Keep the other copy');
    await page.getByRole('button', { name: 'Delete message', exact: true }).click(); await deletion.getByRole('button', { name: 'Delete for me', exact: true }).click(); await expect(page.locator('.message-list')).not.toContainText('Keep the other copy', { timeout: 20000 }); await expect(page.locator('.pinned-message-bar')).toHaveCount(0); await expect(other.locator('.message-list')).toContainText('Keep the other copy');
    await page.reload(); await expect(input).toBeVisible(); await expect(page.locator('.message-list')).not.toContainText('Keep the other copy');
    await input.fill('Remove both copies'); await input.press('Enter'); await expect(other.locator('.message-list')).toContainText('Remove both copies', { timeout: 20000 }); await messageActions(page, 'Remove both copies'); await page.getByRole('button', { name: 'Delete message', exact: true }).click(); await deletion.getByRole('button', { name: 'Delete for everyone', exact: true }).click(); await expect(other.locator('.message-list')).not.toContainText('Remove both copies', { timeout: 20000 }); await expect(other.locator('.message-list')).toContainText('Message deleted'); expect(nativeDialogs).toBe(0);
    const row = page.locator('.inbox-row').filter({ hasText: 'interactionb' }); await row.getByLabel(/^Chat options for/).click(); await row.getByRole('button', { name: 'Pin chat', exact: true }).click(); await expect(row.getByLabel('Pinned chat', { exact: true })).toBeVisible(); await page.reload(); await expect(row.getByLabel('Pinned chat', { exact: true })).toBeVisible();
    await row.getByLabel(/^Chat options for/).click(); await row.getByRole('button', { name: 'Archive chat', exact: true }).click(); await expect(row).toHaveCount(0); await expect(other.getByRole('button', { name: /Archived chats/ })).toHaveCount(0);
    await page.getByRole('button', { name: /Archived chats/ }).click(); await expect(row).toBeVisible(); await row.getByLabel(/^Chat options for/).click(); await row.getByRole('button', { name: 'Unarchive chat', exact: true }).click(); await page.getByRole('button', { name: 'Back to chats', exact: true }).click(); await expect(row).toBeVisible();
    const splitter = page.getByRole('separator', { name: 'Resize conversations', exact: true }); const before = Number(await splitter.getAttribute('aria-valuenow')); await splitter.focus(); await splitter.press('ArrowRight'); await expect(splitter).toHaveAttribute('aria-valuenow', String(before + 20)); await page.reload(); await expect(splitter).toHaveAttribute('aria-valuenow', String(before + 20));
    const box = (await splitter.boundingBox())!; await page.mouse.move(box.x + 3, box.y + 150); await page.mouse.down(); await page.mouse.move(440, box.y + 150, { steps: 8 }); await page.mouse.up(); await expect(splitter).toHaveAttribute('aria-valuenow', '440'); await reflow(page);
    await page.getByRole('button', { name: 'Choose emoji', exact: true }).click(); await page.getByLabel('Search emoji', { exact: true }).fill('family: man, woman, girl'); await page.getByRole('button', { name: 'Insert 👨‍👩‍👧', exact: true }).click(); await expect(input).toHaveValue('👨‍👩‍👧');
    await page.getByRole('button', { name: 'Choose emoji', exact: true }).click(); await page.getByLabel('Search emoji', { exact: true }).fill('waving hand'); await page.getByLabel('Skin tone', { exact: true }).selectOption('🏽'); await page.getByRole('button', { name: 'Insert 👋🏽', exact: true }).click(); await expect(input).toHaveValue('👨‍👩‍👧👋🏽');
    await input.press('Enter'); await expect(other.locator('.message-list')).toContainText('👨‍👩‍👧👋🏽', { timeout: 20000 }); await page.reload(); await expect(page.locator('.message-list')).toContainText('👨‍👩‍👧👋🏽'); await expect(input).toHaveValue('');
    await page.setViewportSize({ width: 390, height: 844 }); await expect(splitter).not.toBeVisible(); await page.getByRole('button', { name: 'Choose emoji', exact: true }).click(); await page.getByLabel('Search emoji', { exact: true }).fill('smiling face'); await accessible(page, info, 'complete-emoji-mobile'); await reflow(page); await page.screenshot({ path: '.cache/qa/emoji-picker-mobile.png' }); await page.keyboard.press('Escape');
  } finally { await context.close(); }
});

test('automatic receipts show delivered/read ticks and do not read a covered conversation', async ({ page, browser, request }) => {
  const a = await register(request, 'readinga'), b = await register(request, 'readingb'), context = await browser.newContext(), other = await context.newPage();
  try {
    await login(page, a.email); await login(other, b.email); await search(page, b.username); await page.getByRole('button', { name: `Open conversation with ${b.username}`, exact: true }).click();
    await other.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await other.locator('.inbox-link').filter({ hasText: 'readinga' }).click(); await expect(other.getByLabel('Message', { exact: true })).toBeVisible(); await other.getByRole('button', { name: 'Report conversation', exact: true }).click(); await expect(other.getByRole('dialog', { name: 'Report conversation', exact: true })).toBeVisible();
    await page.getByLabel('Message', { exact: true }).fill('Read only when foreground'); await page.getByLabel('Message', { exact: true }).press('Enter'); await expect(other.locator('.message-list')).toContainText('Read only when foreground');
    await expect(page.getByRole('img', { name: 'Delivered', exact: true })).toBeVisible({ timeout: 20000 }); await expect(page.getByRole('img', { name: 'Read', exact: true })).toHaveCount(0);
    await other.keyboard.press('Escape'); await other.bringToFront(); await expect(page.getByRole('img', { name: 'Read', exact: true })).toBeVisible({ timeout: 20000 }); await expect(page.locator('.message-receipt.is-read')).toHaveCount(1); await expect(other.getByRole('button', { name: 'Mark messages read', exact: true })).toHaveCount(0);
    await page.getByLabel('Message', { exact: true }).fill(Array.from({ length: 50 }, (_, n) => `Reading line ${n}`).join('\n')); await page.getByLabel('Message', { exact: true }).press('Enter'); await expect(other.locator('.message-list')).toContainText('Reading line 49');
    const scroll = other.locator('.history'); await scroll.hover(); await other.mouse.wheel(0, -10000); await expect.poll(() => scroll.evaluate(node => node.scrollTop)).toBe(0);
    await page.getByLabel('Message', { exact: true }).fill('Below the viewport'); await page.getByLabel('Message', { exact: true }).press('Enter'); await expect(other.locator('.message-list')).toContainText('Below the viewport'); const last = page.locator('.message-list>li').filter({ hasText: 'Below the viewport' }); await expect(last.getByRole('img', { name: 'Delivered', exact: true })).toBeVisible({ timeout: 20000 }); await expect(last.getByRole('img', { name: 'Read', exact: true })).toHaveCount(0);
    await scroll.hover(); await other.mouse.wheel(0, 10000); await other.bringToFront(); await expect(last.getByRole('img', { name: 'Read', exact: true })).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: '.cache/qa/automatic-read-ticks.png' });
  } finally { await context.close(); }
});

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
    await page.getByRole('button', { name: 'Choose emoji', exact: true }).click(); await page.getByLabel('Search emoji', { exact: true }).fill('waving hand'); await page.getByRole('button', { name: 'Insert 👋', exact: true }).click();
    await expect(message).toHaveValue('👋'); await message.press('Enter'); await expect(page.locator('.message-list')).toContainText('👋');
    await other.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await other.locator('.inbox-link').filter({ hasText: 'alex' }).click();
    await other.getByLabel('Message', { exact: true }).fill('Hi Alex! Great to see you here.'); await other.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.locator('.message-list')).toContainText('Great to see you here.', { timeout: 20000 });
    const own = page.locator('.message-list > li.message').filter({ hasText: 'Hey Maya!' }).first(); await own.focus(); await page.keyboard.press('Tab'); await expect(own.getByLabel('Message actions', { exact: true })).toBeFocused(); await page.keyboard.press('Enter'); await page.keyboard.press('Tab'); await expect(own.getByRole('button', { name: /^Reply to/ })).toBeFocused(); await page.keyboard.press('Enter'); await expect(page.locator('.reply-preview')).toContainText('Hey Maya!'); await page.getByRole('button', { name: 'Cancel reply', exact: true }).click();
    await message.fill('Keep my unsent draft'); await messageActions(page, 'Hey Maya!'); await own.getByRole('button', { name: 'Edit message', exact: true }).click(); await expect(message).toHaveValue('Hey Maya!\n'); await expect(message).toBeFocused(); await message.fill('Changed but cancelled'); await page.getByRole('button', { name: 'Cancel edit', exact: true }).click(); await expect(message).toHaveValue('Keep my unsent draft');
    await own.getByRole('button', { name: 'Edit message', exact: true }).click(); await message.fill('Hey Maya, edited in the composer!'); await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.locator('.message-list')).toContainText('edited in the composer!'); await expect(other.locator('.message-list')).toContainText('edited in the composer!', { timeout: 20000 }); await expect(message).toHaveValue('Keep my unsent draft'); await page.getByRole('button', { name: 'Discard draft', exact: true }).click();
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
    await expect(page.getByRole('button', { name: 'Mark messages read', exact: true })).toHaveCount(0);
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

test('report dialogs stay contained and keyboard usable in light/dark desktop and narrow mobile layouts', async ({ page, request }, info) => {
  const owner = await register(request, 'reportui'); await login(page, owner.email);
  await page.getByRole('button', { name: 'New group', exact: true }).click(); await page.getByLabel('Group name', { exact: true }).fill('Report layout'); await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Report this message'); await page.getByLabel('Message', { exact: true }).press('Enter'); await expect(page.locator('.message-list')).toContainText('Report this message');
  await messageActions(page, 'Report this message');
  for (const theme of ['light', 'dark']) {
    if (theme === 'dark') { await page.locator('.main-menu>summary').click(); await page.getByRole('button', { name: 'Night mode', exact: true }).click(); }
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 760 }); await page.getByRole('button', { name: 'Report message', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: 'Report message', exact: true });
      await expect(dialog).toBeVisible(); expect(await dialog.evaluate(node => { const box = node.getBoundingClientRect(); return node.matches(':modal') && box.left >= 0 && box.right <= innerWidth && box.top >= 0 && box.bottom <= innerHeight && node.scrollWidth <= node.clientWidth; })).toBe(true);
      await page.getByLabel('Report reason', { exact: true }).selectOption('harassment'); await accessible(page, info, `report-${theme}-${width}`);
      await page.screenshot({ path: `.cache/qa/report-${theme}-${width}.png` }); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(page.getByRole('button', { name: 'Report message', exact: true })).toBeFocused(); await reflow(page);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.getByRole('button', { name: 'Report message', exact: true }).click(); await page.getByRole('button', { name: 'Submit report', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: 'Report submitted' })).toBeVisible();
});

test('conversation list scrolls independently and clear, delete chat and owner-only group deletion persist on the server', async ({ page, browser, request }) => {
  const owner = await register(request, 'manageowner'), peer = await register(request, 'managepeer'), context = await browser.newContext(), other = await context.newPage();
  try {
    await login(page, owner.email); await login(other, peer.email); await search(page, peer.username); await page.getByRole('button', { name: `Open conversation with ${peer.username}`, exact: true }).click(); await expect(page.getByLabel('Message', { exact: true })).toBeVisible(); const direct = page.url();
    await page.getByLabel('Message', { exact: true }).fill('History that will be cleared'); await page.getByLabel('Message', { exact: true }).press('Enter'); await expect(page.locator('.message-list')).toContainText('History that will be cleared');
    await other.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await other.locator('.inbox-link').filter({ hasText: 'manageowner' }).click();
    await page.getByRole('button', { name: 'Conversation info', exact: true }).click(); await page.getByRole('button', { name: 'Clear chat history', exact: true }).click();
    await page.getByRole('dialog', { name: 'Clear chat history', exact: true }).getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(page.locator('.message-list')).toContainText('History that will be cleared');
    await page.getByRole('button', { name: 'Clear chat history', exact: true }).click(); await page.getByRole('button', { name: 'Confirm clear chat history', exact: true }).click(); await expect(page.locator('.message-list>li.message')).toHaveCount(0); await expect(other.locator('.message-list')).toContainText('History that will be cleared'); await page.reload(); await expect(page.locator('.message-list>li.message')).toHaveCount(0);
    await page.getByRole('button', { name: 'Conversation info', exact: true }).click(); await page.getByRole('button', { name: 'Delete chat', exact: true }).click(); await page.getByRole('button', { name: 'Confirm delete chat', exact: true }).click(); await expect(page).toHaveURL(/\/chat$/); await expect(page.locator('.inbox-link').filter({ hasText: 'managepeer' })).toHaveCount(0);
    await other.getByLabel('Message', { exact: true }).fill('A new message brings this chat back'); await other.getByLabel('Message', { exact: true }).press('Enter'); await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await expect(page.locator('.inbox-link').filter({ hasText: 'managepeer' })).toBeVisible({ timeout: 20000 }); await page.goto(direct); await expect(page.locator('.message-list')).toContainText('A new message brings this chat back'); await expect(page.locator('.message-list')).not.toContainText('History that will be cleared');
    await page.getByRole('button', { name: 'New group', exact: true }).click(); await page.getByLabel('Group name', { exact: true }).fill('Delete for everyone'); await page.getByRole('button', { name: 'Create group', exact: true }).click(); await expect(page.locator('.conversation-name h2')).toHaveText('Delete for everyone'); const groupUrl = page.url();
    await search(page, peer.username, true); await page.getByRole('button', { name: `Invite with ${peer.username}`, exact: true }).click(); await other.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await other.getByRole('button', { name: 'Accept Delete for everyone', exact: true }).click(); await other.getByRole('button', { name: 'Conversation info', exact: true }).click(); await expect(other.getByRole('button', { name: 'Delete group', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Delete group', exact: true }).click(); await page.getByRole('button', { name: 'Confirm delete group', exact: true }).click(); await expect(page).toHaveURL(/\/chat$/); await other.goto(groupUrl); await expect(other.getByRole('heading', { name: 'Conversation unavailable', exact: true })).toBeVisible();
    await page.evaluate(async () => { const session = await (await fetch('/api/v1/auth/session')).json() as { csrfToken: string }; for (let n = 0; n < 16; n++) { const response = await fetch('/api/v1/conversations/groups', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken }, body: JSON.stringify({ title: `Scrollable group ${n}`, clientCommandId: crypto.randomUUID() }) }); if (!response.ok) throw new Error('Could not create scroll fixture'); } });
    await page.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await expect(page.locator('.inbox-link')).toHaveCount(17); await page.setViewportSize({ width: 1280, height: 700 });
    const list = page.locator('.inbox-section'); expect(await list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true); await list.hover(); await page.mouse.wheel(0, 800); await expect.poll(() => list.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true); await page.screenshot({ path: '.cache/qa/scrollable-conversations.png' }); await page.setViewportSize({ width: 390, height: 700 }); await reflow(page); expect(await list.evaluate(node => node.scrollHeight > node.clientHeight)).toBe(true);
  } finally { await context.close(); }
});
