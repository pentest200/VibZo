import { browserEndpoints } from './endpoints.js';
import { test, expect, chromium } from '@playwright/test';
import type { Page, Browser } from '@playwright/test';
import { login, register, search } from './chat-fixture.js';
import { recordMedia } from './media-audit.js';
import { loadConfig } from '@chat/config';
import { createMongoClient } from '@chat/domain';

// Generated Chromium test devices transport actual WebRTC media through the local SFU.
// No hardware camera/microphone, provider secrets, JWTs, SDP or media bytes enter evidence.
async function instrument(page: Page) {
  page.on('response', response => { if (response.request().method() === 'POST' && /\/calls\/[^/]+\/join$/.test(new URL(response.url()).pathname)) console.info('Call credential HTTP status:', response.status()); });
  page.on('console', message => { if (message.text().startsWith('ICE ')) console.info(message.text()); });
  await page.addInitScript(diagnostics => {
    const Original = window.RTCPeerConnection, peers: RTCPeerConnection[] = [];
    Object.assign(window, { __callPeers: peers });
    window.RTCPeerConnection = class extends Original {
      constructor(config?: RTCConfiguration) {
        super(config); peers.push(this);
        if (!diagnostics) return;
        console.info('ICE transport configured:', JSON.stringify({ policy: config?.iceTransportPolicy, servers: config?.iceServers?.map(server => ({ schemes: (typeof server.urls === 'string' ? [server.urls] : server.urls).map(url => url.split(':')[0]), credential: !!server.credential, username: !!server.username })) }));
        // Counter-only diagnostics: no TURN passwords, SDP, JWTs or addresses.
        this.addEventListener('icecandidateerror', event => console.info('ICE gathering error code:', event.errorCode));
        this.addEventListener('icecandidate', event => { if (event.candidate) console.info('ICE candidate type/protocol:', event.candidate.type, event.candidate.protocol); });
        setTimeout(() => {
          const config = this.getConfiguration();
          console.info('ICE policy/server count:', config.iceTransportPolicy, config.iceServers?.length ?? 0, 'state:', this.iceConnectionState);
          console.info('ICE negotiation state:', JSON.stringify({ signaling: this.signalingState, gathering: this.iceGatheringState, localType: this.localDescription?.type ?? null, remoteType: this.remoteDescription?.type ?? null, transceivers: this.getTransceivers().length }));
          void this.getStats().then(report => {
            const counts: Record<string, number> = {};
            for (const row of report.values()) if (['local-candidate', 'remote-candidate', 'candidate-pair'].includes(row.type)) {
              const key = `${row.type}:${row.candidateType ?? row.state}`; counts[key] = (counts[key] ?? 0) + 1;
            }
            console.info('ICE counter diagnostics:', JSON.stringify(counts));
          }).catch(() => {});
        }, 8000);
      }
    };
  }, process.env['CALL_TEST_RELAY'] === 'true');
}
async function received(page: Page, kind: 'video' | 'audio' = 'video') {
  return page.evaluate(async kind => {
    const peers = (window as unknown as { __callPeers: RTCPeerConnection[] }).__callPeers ?? [];
    let bytes = 0, frames = 0;
    for (const pc of peers) for (const value of (await pc.getStats()).values()) if (value.type === 'inbound-rtp' && value.kind === kind) { bytes += value.bytesReceived ?? 0; frames += value.framesDecoded ?? 0; }
    return { bytes, frames };
  }, kind);
}
async function relayOnly(page: Page) {
  await expect.poll(async () => page.evaluate(async () => {
    const types: string[] = [], peers = (window as unknown as { __callPeers: RTCPeerConnection[] }).__callPeers;
    for (const pc of peers) if (pc.connectionState === 'connected') {
      const stats = await pc.getStats();
      for (const value of stats.values()) if (value.type === 'transport' && value.selectedCandidatePairId) {
        const pair = stats.get(value.selectedCandidatePairId), candidate = pair && stats.get(pair.localCandidateId);
        if (candidate) types.push(candidate.candidateType);
      }
    }
    return types.length >= 2 && types.every(type => type === 'relay');
  }), { timeout: 15000 }).toBe(true);
}
async function connected(page: Page) { await expect(page.getByRole('status', { name: 'Media connection', exact: true })).toHaveText('connected', { timeout: 30000 }); }
async function remoteVideo(page: Page, count = 1) {
  await connected(page);
  await expect(page.locator('figure[data-local="false"] video').first()).toBeAttached({ timeout: 20000 });
  await page.locator('figure[data-local="false"] video').first().scrollIntoViewIfNeeded();
  await expect.poll(async () => page.locator('figure[data-local="false"] video').evaluateAll(nodes => nodes.filter(node => (node as HTMLVideoElement).videoWidth > 0 && (node as HTMLVideoElement).readyState >= 2).length), { timeout: 30000 }).toBe(count);
  await expect.poll(async () => (await received(page)).frames, { timeout: 20000 }).toBeGreaterThan(5);
  await expect.poll(async () => (await received(page, 'audio')).bytes, { timeout: 20000 }).toBeGreaterThan(100);
}
async function otherPage(browser: Browser) { const context = await browser.newContext({ permissions: process.env['CALL_TEST_RELAY'] === 'true' ? [] : ['microphone', 'camera'] }); const page = await context.newPage(); await instrument(page); return { context, page }; }
async function realWebhooks() {
  const client = createMongoClient(loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: process.env['E2E_DATABASE'] }));
  try {
    await client.connect();
    await expect.poll(async () => client.db(process.env['E2E_DATABASE']).collection('callWebhookInbox').countDocuments({ kind: 'participant_joined' }), { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  } finally { await client.close(); }
}
test('two independent users exchange real generated audio/video, control devices and rejoin', async ({ page, browser, request }) => {
  const alice = await register(request, 'callalice'), bob = await register(request, 'callbob'), second = await otherPage(browser);
  await instrument(page);
  try {
    await login(page, alice.email); await login(second.page, bob.email);
    await search(page, bob.username); await page.getByRole('button', { name: `Open conversation with ${bob.username}`, exact: true }).click();
    await expect(page.getByRole('button', { name: 'Video call', exact: true })).toBeEnabled();
    await second.page.setViewportSize({ width: 390, height: 844 }); await expect(second.page.locator('.chat-sidebar')).toBeVisible();
    await page.getByRole('button', { name: 'Video call', exact: true }).click();
    await expect(second.page.locator('.incoming-call')).toContainText('Incoming video call');
    await second.page.getByRole('button', { name: 'Accept call', exact: true }).click();
    await remoteVideo(page); await remoteVideo(second.page);
    await realWebhooks();
    if (process.env['CALL_TEST_RELAY'] === 'true') { await relayOnly(page); await relayOnly(second.page); }
    await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Enable microphone', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Enable microphone', exact: true }).click();
    await page.getByRole('button', { name: 'Turn camera off', exact: true }).click();
    await expect(second.page.locator('figure[data-local="false"][data-source="camera"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Enable camera', exact: true }).click(); await remoteVideo(second.page);
    await page.getByRole('button', { name: 'Share screen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop sharing screen', exact: true })).toBeVisible({ timeout: 15000 });
    await expect.poll(async () => second.page.locator('figure[data-local="false"][data-source="screen_share"] video').evaluateAll(nodes => nodes.some(node => (node as HTMLVideoElement).videoWidth > 0)), { timeout: 15000 }).toBe(true);
    await page.getByRole('button', { name: 'Stop sharing screen', exact: true }).click();
    await expect(second.page.locator('figure[data-local="false"][data-source="screen_share"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Stop media on this device', exact: true }).click();
    await expect(page.locator('.call-tracks video')).toHaveCount(0);
    await page.getByRole('button', { name: 'Join or rejoin call', exact: true }).click(); await remoteVideo(page); await remoteVideo(second.page);
    await page.getByText('Connection details', { exact: true }).click();
    await expect(page.locator('.call-diagnostics')).toContainText(/Setup: \d+ ms/);
    await expect.poll(async () => Number((await page.locator('.call-diagnostics').innerText()).match(/Received (\d+) KiB/)?.[1] ?? 0), { timeout: 15000 }).toBeGreaterThan(0);
    await page.screenshot({ path: '.cache/qa/calls-desktop.png', fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: '.cache/qa/calls-mobile.png', fullPage: true });
    await page.getByRole('button', { name: 'End call for everyone', exact: true }).click();
    await expect(second.page.locator('.call-tracks video')).toHaveCount(0, { timeout: 15000 });
    await expect(page.getByRole('region', { name: 'Current call', exact: true }).getByRole('status').first()).toHaveText('ended', { timeout: 15000 });
    await page.locator('.call-launcher > details > summary').click(); await expect(page.locator('.call-history')).toContainText('Video · ended', { timeout: 10000 }); await page.locator('.call-launcher > details > summary').click();
    await page.getByRole('button', { name: 'Close call', exact: true }).click(); await expect(page.locator('.call-panel')).toHaveCount(0);
  } finally { await second.context.close(); }
});
test('three users share a group call and moderator removal forces an authorized room change', async ({ page, browser, request }, info) => {
  const alice = await register(request, 'groupcaller'), bob = await register(request, 'groupbob'), carol = await register(request, 'groupcarol');
  const second = await otherPage(browser), third = await otherPage(browser); await instrument(page);
  try {
    await login(page, alice.email); await login(second.page, bob.email); await login(third.page, carol.email);
    await page.getByRole('button', { name: 'New group', exact: true }).click(); await page.getByLabel('Group name', { exact: true }).fill('Media group'); await page.getByRole('button', { name: 'Create group', exact: true }).click();
    for (const [user, target] of [[bob, second.page], [carol, third.page]] as const) {
      await search(page, user.username, true); await page.getByRole('button', { name: `Invite with ${user.username}`, exact: true }).click();
      await target.getByRole('button', { name: 'Refresh inbox', exact: true }).click(); await target.getByRole('button', { name: 'Accept Media group', exact: true }).click();
    }
    await page.getByRole('button', { name: 'Video call', exact: true }).click();
    for (const target of [second.page, third.page]) await target.getByRole('button', { name: 'Accept call', exact: true }).click();
    await remoteVideo(page, 2); await remoteVideo(second.page, 2); await remoteVideo(third.page, 2);
    await recordMedia(page, info, 'group-owner-connected'); await recordMedia(second.page, info, 'group-peer-connected'); await recordMedia(third.page, info, 'group-third-connected');
    await page.getByRole('button', { name: 'Remove groupcarol from call', exact: true }).click();
    await expect(third.page.locator('.call-tracks video')).toHaveCount(0, { timeout: 15000 });
    await expect(third.page.locator('.call-participants')).toContainText('groupcarol (you)');
    await remoteVideo(page); await remoteVideo(second.page);
    await page.getByRole('button', { name: 'End call for everyone', exact: true }).click();
    await expect(second.page.locator('.call-tracks video')).toHaveCount(0, { timeout: 15000 });
  } finally {
    console.info('Group cleanup: closing peer context'); await second.context.close();
    console.info('Group cleanup: peer closed, closing third context'); await third.context.close();
    console.info('Group cleanup: all auxiliary contexts closed');
  }
});
test('native camera denial keeps a listener connected and exposes a retry control', async ({ page, request }) => {
  // The default test browser's fake permission UI deliberately overrides denial.
  // A separate real browser without that flag exercises native denial with fake devices.
  const deniedBrowser = await chromium.launch({ headless: true, args: ['--use-fake-device-for-media-stream'] });
  const alice = await register(request, 'denialcaller'), bob = await register(request, 'deniallistener'), second = await otherPage(deniedBrowser); await instrument(page);
  try {
    const cdp = await second.context.newCDPSession(second.page), { targetInfo } = await cdp.send('Target.getTargetInfo');
    if (!targetInfo.browserContextId) throw new Error('Expected an isolated browser permission context');
    await cdp.send('Browser.setPermission', { permission: { name: 'camera' }, setting: 'denied', origin: browserEndpoints().origin, browserContextId: targetInfo.browserContextId });
    await login(page, alice.email); await login(second.page, bob.email);
    expect(await second.page.evaluate(async () => (await navigator.permissions.query({ name: 'camera' as PermissionName })).state)).toBe('denied');
    await search(page, bob.username); await page.getByRole('button', { name: `Open conversation with ${bob.username}`, exact: true }).click();
    await page.getByRole('button', { name: 'Video call', exact: true }).click(); await second.page.getByRole('button', { name: 'Accept call', exact: true }).click();
    await connected(second.page);
    await expect(second.page.getByRole('alert')).toContainText('Camera unavailable or permission denied');
    await remoteVideo(second.page);
    await expect(second.page.locator('figure[data-local="true"][data-source="camera"]')).toHaveCount(0);
    await expect(second.page.getByRole('button', { name: 'Enable camera', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'End call for everyone', exact: true }).click();
  } finally { await second.context.close(); await deniedBrowser.close(); }
});
