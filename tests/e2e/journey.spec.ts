import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { loadConfig } from '@chat/config';
import { createMongoClient } from '@chat/domain';
import { login, register, search, messageActions } from './chat-fixture.js';
import { png } from '../fixtures/png.js';
import { accessible, reflow } from './accessibility.js';
import { mediaCounters, recordMedia } from './media-audit.js';

async function send(page: Page, text: string) { await page.getByLabel('Message', { exact: true }).fill(text); await page.getByRole('button', { name: 'Send message', exact: true }).click(); }
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const Original = window.RTCPeerConnection, peers: RTCPeerConnection[] = [];
    Object.assign(window, { __callPeers: peers });
    window.RTCPeerConnection = class extends Original { constructor(config?: RTCConfiguration) { super(config); peers.push(this); } };
  });
}
async function media(page: Page) {
  await expect(page.getByRole('status', { name: 'Media connection', exact: true })).toHaveText('connected', { timeout: 30000 });
  const remote = page.locator('figure[data-local="false"] video').first(); await remote.waitFor(); await remote.scrollIntoViewIfNeeded();
  await expect.poll(() => remote.evaluate(node => (node as HTMLVideoElement).videoWidth), { timeout: 20000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await mediaCounters(page)).videoFrames, { timeout: 20000 }).toBeGreaterThan(5);
  await expect.poll(async () => (await mediaCounters(page)).audioBytes, { timeout: 20000 }).toBeGreaterThan(100);
}

test('independent users complete chat, offline recovery, files, privacy, reporting and real media in one journey', async ({ page, browser, request }, info) => {
  const owner = await register(request, 'journeyowner'), peer = await register(request, 'journeypeer'), reviewer = await register(request, 'journeyreview');
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] }), other = await context.newPage(), reviewContext = await browser.newContext(), review = await reviewContext.newPage();
  await instrument(page); await instrument(other);
  const invalidCallReads: string[] = [];
  for (const tab of [page, other]) tab.on('request', request => { const path = new URL(request.url()).pathname; if (/^\/api\/v1\/calls\/(null|undefined)$/.test(path)) invalidCallReads.push(path); });
  const fixture = process.env['E2E_DATABASE']; if (!/^chat_e2e_auth_[a-f0-9]{32}$/.test(fixture ?? '')) throw new Error('Owned browser fixture required');
  const client = createMongoClient(loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: fixture }));
  try { await client.connect(); await client.db(fixture).collection('users').updateOne({ emailCanonical: reviewer.email }, { $set: { role: 'moderator' } }); } finally { await client.close(); }
  try {
    await login(page, owner.email); await login(other, peer.email); await login(review, reviewer.email);
    await search(page, peer.username); await page.getByRole('button', { name: `Open conversation with ${peer.username}`, exact: true }).click();
    await expect(page).toHaveURL(/\/chat\/[a-f0-9-]{36}$/); const direct = page.url();
    await expect(other.locator('.inbox-link').filter({ hasText: 'journeyowner' })).toBeVisible({ timeout: 10000 }); await other.locator('.inbox-link').filter({ hasText: 'journeyowner' }).click();
    await send(page, 'Integrated original'); await expect(other.locator('.message-list')).toContainText('Integrated original', { timeout: 15000 });
    await messageActions(other, 'Integrated original'); await other.getByRole('button', { name: 'Reply to Integrated original', exact: true }).click(); await send(other, 'Integrated reply'); await expect(page.locator('.message-list')).toContainText('Integrated reply', { timeout: 15000 });
    await context.setOffline(true); await messageActions(other, 'Integrated original'); await other.locator('.message-list li').filter({ hasText: 'Integrated original' }).getByRole('button', { name: 'Like 0', exact: true }).click();
    await other.bringToFront(); await expect(other.getByRole('button', { name: 'Mark messages read', exact: true })).toHaveCount(0);
    await messageActions(page, 'Integrated original'); await page.locator('.message-list li').filter({ hasText: 'Integrated original' }).getByRole('button', { name: 'Edit message', exact: true }).click();
    await page.getByLabel('Message', { exact: true }).fill('Integrated edited'); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.locator('.message-list')).toContainText('Integrated edited');
    await context.setOffline(false); await expect(other.locator('.message-list')).toContainText('Integrated edited', { timeout: 25000 });
    await expect(page.locator('.message-list li').filter({ hasText: 'Integrated edited' }).getByRole('button', { name: 'Like 1', exact: true })).toBeVisible({ timeout: 25000 });
    await expect(page.getByRole('img', { name: 'Read', exact: true }).first()).toBeVisible({ timeout: 25000 });
    let blocked = true; const ids: string[] = [];
    await page.context().route('**/api/v1/messages', async route => { ids.push((route.request().postDataJSON() as { clientMessageId: string }).clientMessageId); if (blocked) await route.abort('failed'); else await route.continue(); });
    await send(page, 'Retained command across reload'); await expect(page.getByLabel('Pending commands')).toContainText('Retained command across reload');
    await page.reload(); await expect(page.getByLabel('Pending commands')).toContainText('Retained command across reload'); blocked = false;
    await expect(other.locator('.message-list li').filter({ hasText: 'Retained command across reload' })).toHaveCount(1, { timeout: 40000 });
    expect(new Set(ids).size).toBe(1); await page.context().unroute('**/api/v1/messages');
    const bytes = Buffer.from('Integrated scanned private file.\n');
    await page.getByRole('button', { name: 'Attach files', exact: true }).click(); await page.getByLabel('Attach a file', { exact: true }).setInputFiles({ name: 'journey.txt', mimeType: 'text/plain', buffer: bytes });
    await expect(page.locator('.attachment-picker')).toContainText('Ready to send', { timeout: 45000 }); await page.getByRole('checkbox', { name: 'journey.txt', exact: true }).check(); await page.getByRole('button', { name: 'Send message', exact: true }).click();
    const downloaded = other.waitForEvent('download'); await other.getByRole('button', { name: 'Download journey.txt', exact: true }).click(); expect(await readFile((await (await downloaded).path())!)).toEqual(bytes);
    await page.goto('/account'); const panel = page.getByRole('region', { name: 'Avatar settings', exact: true });
    await expect(panel.getByRole('checkbox')).not.toBeChecked(); await panel.getByLabel('Upload avatar', { exact: true }).setInputFiles({ name: 'journey.png', mimeType: 'image/png', buffer: png(24, 24) });
    await expect(panel).toContainText('Ready to use', { timeout: 45000 }); await panel.getByRole('button', { name: 'Use as avatar', exact: true }).click();
    await expect(panel.getByRole('img')).toBeVisible(); await expect(other.locator('.conversation-heading img')).toHaveCount(0);
    const shared = page.waitForResponse(response => response.url().endsWith('/api/v1/avatars/privacy') && response.status() === 200); await panel.getByRole('checkbox').check(); await shared;
    await expect(other.locator('.conversation-heading img')).toBeVisible({ timeout: 25000 }); await page.goto(direct);
    await page.getByRole('button', { name: 'Video call', exact: true }).click(); await expect(other.locator('.incoming-call')).toBeVisible(); await other.getByRole('button', { name: 'Accept call', exact: true }).click();
    await media(page); await media(other); expect(invalidCallReads).toEqual([]); await accessible(page, info, 'active-call');
    await page.getByRole('button', { name: 'Mute microphone', exact: true }).click(); await expect(page.getByRole('button', { name: 'Enable microphone', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Enable microphone', exact: true }).click();
    await page.getByRole('button', { name: 'Share screen', exact: true }).click(); await expect(other.locator('figure[data-local="false"][data-source="screen_share"] video')).toBeVisible({ timeout: 15000 });
    await expect.poll(() => other.locator('figure[data-local="false"][data-source="screen_share"] video').evaluate(node => (node as HTMLVideoElement).videoWidth), { timeout: 15000 }).toBeGreaterThan(0);
    await page.getByRole('button', { name: 'Stop sharing screen', exact: true }).click(); await recordMedia(other, info, 'journey-connected');
    await page.getByRole('button', { name: 'End call for everyone', exact: true }).click(); await expect(other.locator('.call-tracks video')).toHaveCount(0, { timeout: 15000 });
    for (const target of [page, other]) await target.getByRole('button', { name: 'Close call', exact: true }).click();
    await page.getByRole('button', { name: 'New group', exact: true }).click(); await page.getByLabel('Group name', { exact: true }).fill('Journey group'); await page.getByRole('button', { name: 'Create group', exact: true }).click(); await expect(page.getByLabel('Group title', { exact: true })).toBeVisible(); const group = page.url();
    expect((await review.request.get(`/api/v1/conversations/${group.split('/').at(-1)}`)).status()).toBe(403);
    await search(page, peer.username, true); await page.getByRole('button', { name: `Invite with ${peer.username}`, exact: true }).click(); await other.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await other.getByRole('button', { name: 'Accept Journey group', exact: true }).click(); await expect(other).toHaveURL(group);
    await page.reload(); await page.getByRole('button', { name: `Make admin ${peer.username}`, exact: true }).click(); await expect(page.getByRole('button', { name: `Make member ${peer.username}`, exact: true })).toBeVisible(); await other.reload(); await expect(other.locator('.conversation-heading')).toContainText('You are admin');
    await send(page, 'Group authority and privacy'); await expect(other.locator('.message-list')).toContainText('Group authority and privacy', { timeout: 15000 });
    page.once('dialog', dialog => { void dialog.accept(); }); await page.getByRole('button', { name: `Remove ${peer.username}`, exact: true }).click(); await expect(other.getByRole('heading', { name: 'Conversation unavailable', exact: true })).toBeVisible({ timeout: 25000 });
    await other.goto(direct); const message = other.locator('.message-list li').filter({ hasText: 'Integrated edited' }); await messageActions(other, 'Integrated edited'); await message.getByRole('button', { name: 'Report message', exact: true }).click(); await other.getByRole('dialog', { name: 'Report message', exact: true }).getByRole('combobox', { name: 'Report reason', exact: true }).selectOption('harassment'); await other.getByRole('dialog', { name: 'Report message', exact: true }).getByRole('button', { name: 'Submit report', exact: true }).click();
    await expect(message.getByRole('status')).toContainText('Report submitted'); await review.goto('/account'); await review.getByRole('button', { name: 'Remove reported message', exact: true }).click(); await expect(other.locator('.message-list')).toContainText('Message deleted', { timeout: 25000 });
    await page.goto(direct); page.once('dialog', dialog => { void dialog.accept(); }); await page.getByRole('button', { name: 'Block contact', exact: true }).click(); await expect(page.locator('.composer')).toHaveCount(0); await expect(other.locator('.conversation-heading img')).toHaveCount(0, { timeout: 25000 });
    await page.getByText('Blocked contacts', { exact: true }).click(); await page.getByRole('button', { name: `Unblock ${peer.username}`, exact: true }).click(); await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 }); await reflow(page); await accessible(page, info, 'journey-mobile'); await page.screenshot({ path: '.cache/qa/journey-mobile.png', fullPage: true });
    await page.goto('/account'); await expect(page.getByLabel('Notification settings')).toContainText('Background delivery is unavailable');
    await page.getByRole('button', { name: 'Delete my account', exact: true }).click(); await page.getByLabel('Confirm deletion password', { exact: true }).fill('Conversation-browser-password-123'); await page.getByLabel('Type DELETE to confirm', { exact: true }).fill('DELETE'); await page.getByRole('button', { name: 'Permanently delete account', exact: true }).click(); await expect(page).toHaveURL(/\/login$/);
    await expect(other.locator('.conversation-heading img')).toHaveCount(0, { timeout: 25000 });
  } finally { await context.setOffline(false); await context.close(); await reviewContext.close(); }
});
