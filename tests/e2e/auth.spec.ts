import { browserEndpoints } from './endpoints.js';
import { randomUUID } from 'node:crypto';
import { test, expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

const password = 'Browser-synthetic-password-123';
const mailpitOrigin = process.env['MAILPIT_URL'] ?? 'http://127.0.0.1:8025';
async function signIn(page: Page, email: string, secret = password) {
  await page.goto('/login'); await page.getByLabel('Email', {exact:true}).fill(email);
  await page.getByLabel('Password',{exact:true}).fill(secret); await page.getByRole('button',{name:'Sign in',exact:true}).click();
  await expect(page).toHaveURL(/\/account$/);
}
async function emailLink(request: APIRequestContext, recipient: string, purpose: 'verify' | 'reset') {
  let link = '';
  await expect.poll(async () => {
    const response = await request.get(`${mailpitOrigin}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`);
    const result = await response.json() as { messages: { ID: string; Subject: string }[] };
    for (const message of result.messages) {
      if (!message.Subject.toLowerCase().includes(purpose === 'verify' ? 'verify' : 'reset')) continue;
      const detail = await request.get(`${mailpitOrigin}/api/v1/message/${message.ID}`);
      const body = await detail.json() as { Text: string };
      const match = body.Text.match(new RegExp(`http://localhost:${browserEndpoints().web}/${purpose}#token=[A-Za-z0-9_-]{43}`));
      if (match) { link = match[0]; return true; }
    }
    return false;
  }, {timeout:20000}).toBe(true);
  return link;
}
test('real browser registration, local email verification, profile/privacy, sessions, reset and logout', async ({ page, browser, request }) => {
  const suffix = randomUUID().slice(0,8); const email = `browser_${suffix}@example.test`;
  await page.goto('/register'); await page.getByLabel('Email',{exact:true}).fill(email); await page.getByLabel('Username',{exact:true}).fill(`browser_${suffix}`);
  await page.getByLabel('Display name',{exact:true}).fill('Browser Alice'); await page.getByLabel('Password',{exact:true}).fill(password);
  await page.getByRole('button',{name:'Create account',exact:true}).click(); await expect(page.getByRole('status')).toContainText('If these details are eligible');
  await page.goto(await emailLink(request,email,'verify')); await expect(page).toHaveURL(/\/verify$/);
  await page.getByRole('button',{name:'Verify email',exact:true}).click(); await expect(page.getByRole('status')).toContainText('Your email is verified');
  await signIn(page,email); await expect(page.getByText('Email verified',{exact:false})).toBeVisible();
  const cookies = await page.context().cookies(); const cookie = cookies.find(item=>item.name==='commonroom_session');
  expect(cookie?.httpOnly).toBe(true); expect(cookie?.sameSite).toBe('Lax'); expect(cookie?.secure).toBe(false); // local HTTP exception only
  expect(await page.evaluate(()=>Object.keys(localStorage))).toEqual([]);
  await page.getByLabel('Display name',{exact:true}).fill('Alice Updated'); await page.getByLabel('Show when I’m online').uncheck();
  await page.getByRole('button',{name:'Save profile',exact:true}).click(); await expect(page.getByRole('heading',{name:'Hello, Alice Updated.'})).toBeVisible();
  await page.screenshot({path:'.cache/qa/auth-account.png',fullPage:true});
  const secondContext = await browser.newContext(); const second = await secondContext.newPage();
  try {
    await signIn(second,email); await expect(page.getByRole('heading',{name:'Active sessions'})).toBeVisible();
    await page.reload(); await expect(page.getByText('Another device',{exact:false})).toBeVisible();
    await page.getByRole('button',{name:'Sign out session',exact:true}).click(); await expect(page.getByText('Another device',{exact:false})).toHaveCount(0);
    await second.reload(); await expect(second).toHaveURL(/\/login$/);
    // A second tab shares cookies and receives only invalidations, never credentials.
    const tab = await page.context().newPage(); await tab.goto('/account'); await expect(tab.getByRole('heading',{name:'Hello, Alice Updated.'})).toBeVisible();
    await page.getByRole('button',{name:'Sign out',exact:true}).click(); await expect(page).toHaveURL(/\/login$/); await expect(tab).toHaveURL(/\/login$/);
    await tab.close();
    await page.goto('/forgot'); await page.getByLabel('Email',{exact:true}).fill(email); await page.getByRole('button',{name:'Send reset link'}).click();
    await expect(page.getByRole('status')).toContainText('If these details are eligible');
    const resetLink = await emailLink(request,email,'reset'); await page.goto(resetLink);
    await page.getByLabel('New password',{exact:true}).fill('Reset-browser-password-456'); await page.getByRole('button',{name:'Reset password',exact:true}).click();
    await expect(page.getByRole('status')).toContainText('Password reset');
    await page.goto(resetLink); await page.getByLabel('New password',{exact:true}).fill('Reset-browser-password-456'); await page.getByRole('button',{name:'Reset password',exact:true}).click();
    await expect(page.getByRole('alert')).toContainText('invalid or expired');
    await signIn(page,email,'Reset-browser-password-456');
    await page.getByLabel('Current password',{exact:true}).fill('Reset-browser-password-456'); await page.getByLabel('New password',{exact:true}).fill('Changed-browser-password-789');
    await page.getByRole('button',{name:'Change password',exact:true}).click(); await expect(page).toHaveURL(/\/login$/);
    await signIn(page,email,'Changed-browser-password-789'); await page.getByRole('button',{name:'Sign out all devices'}).click(); await expect(page).toHaveURL(/\/login$/);
  } finally { await secondContext.close(); }
});
test('mobile authentication remains usable and unauthenticated account content stays hidden', async ({ page }) => {
  await page.setViewportSize({width:390,height:844}); await page.goto('/account'); await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading',{name:'Profile & privacy'})).toHaveCount(0);
  await expect(page.getByLabel('Email',{exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.screenshot({path:'.cache/qa/auth-mobile.png',fullPage:true});
});
