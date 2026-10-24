import { createServer } from 'node:http';
import { createECDH, randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig } from '@chat/config';
import { pushSubscriptionSchema } from '@chat/contracts';
import { webPushProvider } from '@chat/domain';
const selected = process.argv[2] ?? 'chrome';
if (process.argv.length > 3 || !['chrome', 'firefox', 'chromium'].includes(selected) || process.env['NODE_ENV'] === 'production') throw new Error('Use test:push:native [chrome|firefox|chromium] locally');
if (await realpath('.cache') !== resolve('.cache')) throw new Error('Native push cache cannot redirect');
process.env['PLAYWRIGHT_BROWSERS_PATH'] ??= resolve('.cache/ms-playwright');
// Playwright resolves its browser registry when imported. Set the local cache
// first so an installed Firefox is found without an external shell override.
const { chromium, firefox } = await import('@playwright/test');
const directory = resolve('.cache', `native-push-${randomUUID()}`); await mkdir(directory, { mode: 0o700 });
console.info('Native push result directory:', directory);
const key = createECDH('prime256v1'); key.generateKeys();
const config = loadConfig({ NODE_ENV: 'test', PUSH_ENABLED: 'true', VAPID_PUBLIC_KEY: key.getPublicKey().toString('base64url'), VAPID_PRIVATE_KEY: key.getPrivateKey().toString('base64url') });
const source = `self.addEventListener('push',event=>event.waitUntil((async()=>{
 const payload=event.data?.json(); if(payload?.v!==1||payload?.kind!=='inbox')throw new Error('Unexpected generic push');
 const cache=await caches.open('owned-native-push');await cache.put('/received',new Response('1'));
 await self.registration.showNotification('Commonroom',{tag:'owned-native-push',body:'You have new activity.'});
})()));`;
const server = createServer((request, response) => { response.setHeader('Content-Type', request.url === '/sw.js' ? 'text/javascript' : 'text/html'); response.end(request.url === '/sw.js' ? source : '<!doctype html><title>Owned native push verification</title>'); });
await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing owned native push listener');
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let page: Awaited<ReturnType<NonNullable<typeof browser>['newPage']>> | undefined;
const result: Record<string, unknown> = { browser: selected, passed: false, stage: 'launch', cleanup: 'not-completed', remoteSubscriptionCleanup: 'not-created', physicalDisplayVerified: false };
const timer = setTimeout(() => { result['limitHit'] = true; void browser?.close().catch(() => {}); }, 45000);
try {
  browser = selected === 'firefox' ? await firefox.launch({ headless: true, firefoxUserPrefs: { 'dom.push.enabled': true, 'dom.push.connection.enabled': true, 'dom.push.serverURL': 'wss://push.services.mozilla.com/', 'dom.webnotifications.enabled': true } }) :
    await chromium.launch({ headless: true, ...(selected === 'chrome' ? { channel: 'chrome', ignoreDefaultArgs: ['--disable-background-networking'] } : {}) });
  result['version'] = browser.version();
  const origin = `http://localhost:${address.port}`, context = await browser.newContext();
  await context.grantPermissions(['notifications'], { origin }); page = await context.newPage(); await page.goto(origin);
  result['stage'] = 'permission'; result['permission'] = await page.evaluate(() => Notification.permission);
  if (result['permission'] !== 'granted') throw new Error('Native permission unavailable');
  result['stage'] = 'subscription';
  const raw = await page.evaluate(async publicKey => {
    const registration = await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
    const applicationServerKey = Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), value => value.charCodeAt(0));
    return (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })).toJSON();
  }, config.VAPID_PUBLIC_KEY);
  const subscription = pushSubscriptionSchema.parse(raw); result['nativeSubscription'] = true; result['remoteSubscriptionCleanup'] = 'unconfirmed';
  result['stage'] = 'provider'; await webPushProvider(config).send(subscription, 'owned-native-push'); result['providerAccepted'] = true;
  result['stage'] = 'delivery'; const until = Date.now() + 20000;
  while (!await page.evaluate(async () => !!await (await caches.open('owned-native-push')).match('/received'))) {
    if (Date.now() >= until) throw new Error('Native delivery deadline'); await new Promise(done => setTimeout(done, 250));
  }
  const notifications = await page.evaluate(async () => (await (await navigator.serviceWorker.ready).getNotifications()).length);
  result['nativeNotificationCount'] = notifications;
  if (notifications !== 1) throw new Error('Native browser notification missing');
  result['passed'] = true; result['stage'] = 'complete';
} catch {
  // Neither provider exceptions nor browser stacks enter the result: both can
  // contain endpoint credentials. The last finite stage identifies the gate.
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  let cleanupFailed = false;
  try {
    if (page && !page.isClosed()) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      const cleaned = await Promise.race([page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration();
      let removed = true;
      if (registration) { for (const notification of await registration.getNotifications()) notification.close(); const subscription = await registration.pushManager.getSubscription(); if (subscription) removed = await subscription.unsubscribe(); await registration.unregister(); }
      await caches.delete('owned-native-push');
      return removed;
      }), new Promise<boolean>(done => { cleanupTimer = setTimeout(() => done(false), 5000); })]);
      clearTimeout(cleanupTimer);
      if (cleaned && result['nativeSubscription']) result['remoteSubscriptionCleanup'] = 'passed';
      if (!cleaned) cleanupFailed = true;
    } else if (result['limitHit'] && result['stage'] === 'subscription') result['remoteSubscriptionCleanup'] = 'unconfirmed';
  } catch { cleanupFailed = true; }
  try { await browser?.close(); } catch { cleanupFailed = true; }
  try { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } catch { cleanupFailed = true; }
  result['cleanup'] = cleanupFailed ? 'failed' : 'passed';
  if (cleanupFailed || result['nativeSubscription'] && result['remoteSubscriptionCleanup'] !== 'passed') { result['passed'] = false; process.exitCode = 1; }
  await writeFile(resolve(directory, 'result.json'), JSON.stringify(result), { mode: 0o600 }); console.info(JSON.stringify(result));
}
