import { browserEndpoints } from './endpoints.js';
import { test, expect } from '@playwright/test';
import { accessible, reflow } from './accessibility.js';
import { login, register, search } from './chat-fixture.js';

test('public routes, token errors and keyboard navigation expose named landmarks and focus', async ({ page }, info) => {
  for (const [path, name] of [['/', 'welcome'], ['/register', 'register'], ['/login', 'login'], ['/forgot', 'forgot'], ['/verify', 'verify-missing'], ['/reset', 'reset-missing'], ['/missing', 'not-found']] as const) {
    await page.goto(path); await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('main')).toHaveCount(1); await expect(page.getByRole('banner')).toHaveCount(1); await expect(page.getByRole('contentinfo')).toHaveCount(1);
    await accessible(page, info, name); await reflow(page);
  }
  await page.goto('/login'); await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: 'Skip to content', exact: true }); await expect(skip).toBeFocused(); await expect(skip).toBeInViewport();
  expect(await skip.evaluate(node => getComputedStyle(node).outlineStyle)).not.toBe('none');
  await page.keyboard.press('Enter'); await expect(page.getByRole('main')).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByLabel('Email', { exact: true })).toBeFocused();
  await page.getByRole('link', { name: 'Forgot your password?', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/forgot$/); await expect(page.getByRole('main')).toBeFocused(); await expect(page).toHaveTitle('Password recovery · Commonroom');
  await page.goto('/login'); await page.getByLabel('Email', { exact: true }).fill('missing_a11y@example.test'); await page.getByLabel('Password', { exact: true }).fill('Wrong-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page.getByRole('alert')).toBeVisible();
  await accessible(page, info, 'login-error');
});

test('account reflows at 320px, keeps the CTA clear and exposes privacy, deletion and recovery controls', async ({ page, request }, info) => {
  const user = await register(request, 'accessowner'); await login(page, user.email); await page.goto('/account');
  await expect(page.getByLabel('Upload avatar', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Notification settings', exact: true })).toContainText('Background delivery is unavailable');
  await expect(page.getByRole('button', { name: 'Enable notifications on this device', exact: true })).toBeDisabled();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await reflow(page);
    const cta = page.getByRole('link', { name: 'Open conversations', exact: true }), paragraph = page.locator('.account-heading');
    const linkBox = await cta.boundingBox(), textBox = await paragraph.boundingBox();
    expect(linkBox && textBox && linkBox.y >= textBox.y + textBox.height).toBe(true);
    await accessible(page, info, `account-${width}`); await page.screenshot({ path: `.cache/qa/a11y-account-${width}.png`, fullPage: true });
  }
  // 640 CSS pixels represents the layout viewport of 200% zoom on a 1280px display.
  await page.setViewportSize({ width: 640, height: 450 }); await reflow(page); await accessible(page, info, 'account-reflow');
  await page.getByRole('button', { name: 'Delete my account', exact: true }).click();
  await expect(page.getByLabel('Confirm deletion password', { exact: true })).toBeVisible(); await accessible(page, info, 'deletion-confirmation');
  let unavailable = true;
  await page.route('**/api/v1/avatars', async route => unavailable ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ code: 'UNAVAILABLE', message: 'Temporarily unavailable.' }) }) : route.continue());
  await page.reload(); await expect(page.getByRole('alert').filter({ hasText: 'Avatar settings unavailable' })).toBeVisible();
  await accessible(page, info, 'account-service-error'); unavailable = false;
  await page.getByRole('button', { name: 'Retry avatar settings', exact: true }).click(); await expect(page.getByLabel('Upload avatar', { exact: true })).toBeVisible();
});

test('chat, report forms and group controls stay keyboard accessible at mobile widths', async ({ page, request }, info) => {
  const owner = await register(request, 'accesschat'), peer = await register(request, 'accesspeer'); await login(page, owner.email);
  await accessible(page, info, 'empty-inbox');
  await page.getByRole('button', { name: 'New group', exact: true }).click(); await page.getByLabel('Group name', { exact: true }).fill('Accessible group'); await page.getByRole('button', { name: 'Create group', exact: true }).click();
  await expect(page.getByLabel('Message', { exact: true })).toBeVisible();
  await page.getByLabel('Message', { exact: true }).fill('Keyboard and privacy audit'); await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.message-list')).toContainText('Keyboard and privacy audit');
  await search(page, peer.username, true); await page.getByRole('button', { name: `Invite with ${peer.username}`, exact: true }).click();
  await expect(page.locator('.member-list')).toContainText('Invitation pending');
  await page.getByRole('button', { name: 'Report conversation', exact: true }).focus(); await page.keyboard.press('Enter');
  await page.keyboard.press('Tab'); await expect(page.getByRole('combobox', { name: 'Report reason', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab'); await expect(page.getByRole('button', { name: 'Close Report conversation', exact: true })).toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.getByRole('combobox', { name: 'Report reason', exact: true })).toBeFocused();
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 }); await reflow(page); await accessible(page, info, `group-${width}`);
    await page.screenshot({ path: `.cache/qa/a11y-chat-${width}.png`, fullPage: true });
  }
  await page.getByRole('button', { name: 'Submit report', exact: true }).click(); await expect(page.getByRole('status').filter({ hasText: 'Report submitted' })).toBeVisible();
  const jump = page.getByRole('link', { name: 'Skip to conversation', exact: true }); await jump.focus(); await page.keyboard.press('Enter'); await expect(page.locator('#conversation-pane')).toBeFocused();
  await page.getByRole('button', { name: 'Conversation info', exact: true }).click();
  const settings = page.getByText('Group settings', { exact: true }); await settings.focus(); await page.keyboard.press('Space'); await expect(page.getByLabel('Group title', { exact: true })).not.toBeVisible();
  await page.keyboard.press('Space'); await expect(page.getByLabel('Group title', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close conversation info', exact: true }).click();
});

test('unverified accounts disclose restricted actions and retain verification recovery', async ({ page, request }, info) => {
  const email = `unverified_${crypto.randomUUID()}@example.test`;
  expect((await request.post('/api/v1/auth/register', { headers: { Origin: browserEndpoints().origin }, data: { email, username: `unverified_${crypto.randomUUID().slice(0, 8)}`, displayName: 'Unverified account', password: 'Conversation-browser-password-123' } })).status()).toBe(202);
  await page.goto('/login'); await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill('Conversation-browser-password-123'); await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/account$/); await expect(page.getByRole('button', { name: 'Send a new verification email', exact: true })).toBeEnabled();
  await expect(page.getByRole('region', { name: 'Avatar settings', exact: true })).toContainText('Verify your email'); await expect(page.getByRole('link', { name: 'Open conversations', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Allow account notifications', exact: true })).toBeDisabled(); await accessible(page, info, 'unverified-account');
  await page.goto('/chat'); await expect(page).toHaveURL(/\/account$/);
});
