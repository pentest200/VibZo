import { randomUUID } from 'node:crypto';
import { expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import { browserEndpoints } from './endpoints.js';
export const password = 'Conversation-browser-password-123';
const mailpitOrigin = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';
const origin = browserEndpoints().origin;
export async function register(request: APIRequestContext, name: string) {
  const username = `${name}_${randomUUID().slice(0, 8)}`, email = `${username}@example.test`;
  const response = await request.post('/api/v1/auth/register', { headers: { Origin: origin }, data: { email, username, displayName: name, password } });
  expect(response.status()).toBe(202);
  let token = '';
  await expect.poll(async () => {
    const messages = await (await request.get(`${mailpitOrigin}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json() as { messages: { ID: string }[] };
    for (const message of messages.messages) {
      const body = await (await request.get(`${mailpitOrigin}/api/v1/message/${message.ID}`)).json() as { Text: string };
      token = body.Text.match(/\/verify#token=([A-Za-z0-9_-]{43})/)?.[1] ?? ''; if (token) return true;
    }
    return false;
  }, { timeout: 20000 }).toBe(true);
  expect((await request.post('/api/v1/auth/verify', { headers: { Origin: origin }, data: { token } })).status()).toBe(200);
  return { username, email };
}
export async function login(page: Page, email: string) {
  await page.goto('/login'); await page.getByLabel('Email', { exact: true }).fill(email); await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click(); await expect(page).toHaveURL(/\/account$/);
  await page.getByRole('link', { name: 'Open conversations' }).click(); await expect(page.getByRole('heading', { name: 'Conversations', exact: true })).toBeVisible();
}
export async function search(page: Page, username: string, invite = false) {
  if (!invite) await page.getByRole('button', { name: 'New message', exact: true }).click();
  const scope = invite ? page.locator('.chat-main') : page.locator('.chat-sidebar');
  await scope.getByLabel('Username prefix').fill(username); await scope.getByRole('button', { name: 'Search people' }).click();
}
export async function messageActions(page: Page, text?: string) {
  const rows = page.locator('.message-list > li.message');
  await (text ? rows.filter({ hasText: text }).first() : rows.first()).hover();
}
