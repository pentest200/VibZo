import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loadConfig } from '@chat/config';
import { createMongoClient, LiveKitProvider } from '@chat/domain';
import type { CallRecord } from '@chat/domain';
import { login, register, search } from './chat-fixture.js';
import { controlUpgradeMedia } from '../integration/upgrade-media.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { recordMedia } from './media-audit.js';

async function media(page: Page) {
  await expect(page.getByRole('status', { name: 'Media connection', exact: true })).toHaveText('connected', { timeout: 45000 });
  // Adaptive video pauses off-screen subscriptions after the rejoin controls scroll the page.
  await expect(page.locator('figure[data-local="false"] video').first()).toBeAttached({ timeout: 20000 });
  await page.locator('figure[data-local="false"] video').first().scrollIntoViewIfNeeded();
  await expect.poll(() => page.locator('figure[data-local="false"] video').evaluateAll(nodes => nodes.some(node => (node as HTMLVideoElement).videoWidth > 0 && (node as HTMLVideoElement).readyState >= 2)), { timeout: 30000 }).toBe(true);
  const counters = () => page.evaluate(async () => {
    const peers = (window as unknown as { upgradePeers: RTCPeerConnection[] }).upgradePeers;
    let frames = 0, audio = 0;
    for (const peer of peers) if (peer.connectionState === 'connected') for (const item of (await peer.getStats()).values()) if (item.type === 'inbound-rtp') { frames += item.framesDecoded ?? 0; if (item.kind === 'audio') audio += item.bytesReceived ?? 0; }
    return { frames, audio };
  });
  await expect.poll(async () => (await counters()).frames, { timeout: 30000 }).toBeGreaterThan(5);
  await expect.poll(async () => (await counters()).audio, { timeout: 30000 }).toBeGreaterThan(100);
}
async function inspectMedia(page: Page) { await page.addInitScript(() => {
  const Original = window.RTCPeerConnection, peers: RTCPeerConnection[] = [], tracks: MediaStreamTrack[] = [];
  Object.assign(window, { upgradePeers: peers, upgradeTracks: tracks, __callPeers: peers, codecCollisions: 0 });
  const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async constraints => {
    const stream = await capture(constraints); tracks.push(...stream.getTracks()); return stream;
  };
  const rejected = (error: unknown) => {
    if (/codec collision|payload type collision/i.test(String(error))) {
      const state = window as unknown as { codecCollisions: number }; state.codecCollisions++;
    }
  };
  window.RTCPeerConnection = class extends Original {
    constructor(config?: RTCConfiguration) { super(config); peers.push(this); }
    override async setLocalDescription(description?: RTCLocalSessionDescriptionInit) {
      try { await super.setLocalDescription(description); }
      catch (error) {
        rejected(error);
        throw error;
      }
    }
    override async setRemoteDescription(description: RTCSessionDescriptionInit) {
      try { await super.setRemoteDescription(description); }
      catch (error) { rejected(error); throw error; }
    }
  };
}); }
async function released(page: Page) {
  await expect.poll(() => page.evaluate(() => {
    const { upgradePeers: peers, upgradeTracks: tracks } = window as unknown as { upgradePeers: RTCPeerConnection[]; upgradeTracks: MediaStreamTrack[] };
    return peers.length > 0 && tracks.length > 0 && tracks.every(track => track.readyState === 'ended') && peers.every(peer => peer.connectionState === 'closed');
  }), { timeout: 15000 }).toBe(true);
}
async function stopCapturedMedia(page: Page) {
  if (page.isClosed()) return;
  await page.evaluate(() => {
    const state = window as unknown as { upgradePeers?: RTCPeerConnection[]; upgradeTracks?: MediaStreamTrack[] };
    for (const track of state.upgradeTracks ?? []) track.stop();
    for (const peer of state.upgradePeers ?? []) peer.close();
  });
}
test('survives a killed SFU, rotates its room and visibly rejoins only authorized users with real media', async ({ page, browser, request }, info) => {
  const alice = await register(request, 'upgradealice'), bob = await register(request, 'upgradebob'), outsider = await register(request, 'upgradeoutsider');
  const second = await browser.newContext({ permissions: ['microphone', 'camera'] }), other = await second.newPage();
  const unauthorized = await browser.newContext(), stranger = await unauthorized.newPage();
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: process.env['E2E_DATABASE'] }), client = createMongoClient(config), db = client.db(config.MONGODB_DATABASE), provider = new LiveKitProvider(config);
  let killed = false, completed = false;
  try {
    await client.connect(); await inspectMedia(page); await inspectMedia(other);
    await login(page, alice.email); await login(other, bob.email); await login(stranger, outsider.email);
    await search(page, bob.username); await page.getByRole('button', { name: `Open conversation with ${bob.username}`, exact: true }).click();
    await page.getByRole('button', { name: 'Video call', exact: true }).click(); await other.getByRole('button', { name: 'Accept call', exact: true }).click();
    await media(page); await media(other);
    await recordMedia(page, info, 'upgrade-before-owner'); await recordMedia(other, info, 'upgrade-before-peer');
    const before = await db.collection<CallRecord>('calls').findOne({ open: true }); expect(before).toBeTruthy();
    const account = await (await stranger.request.get('/api/v1/auth/session')).json() as { csrfToken: string };
    const deny = () => stranger.request.post(`/api/v1/calls/${before!._id}/join`, { headers: { Origin: 'http://localhost:5173', 'X-CSRF-Token': account.csrfToken }, data: {} });
    expect((await deny()).status()).toBe(403);
    const interruptedAt = performance.now();
    expect(await controlUpgradeMedia('kill')).toMatchObject({ Running: false, ExitCode: 137 }); killed = true;
    await expect.poll(async () => await provider.health(), { timeout: 10000 }).toBe(false);
    await expect(page.getByRole('status', { name: 'Media connection', exact: true })).not.toHaveText('connected', { timeout: 15000 });
    await controlUpgradeMedia('start'); killed = false;
    await expect.poll(async () => await provider.health(), { timeout: 30000 }).toBe(true);
    await expect.poll(async () => (await db.collection<CallRecord>('calls').findOne({ _id: before!._id }))?.generation, { timeout: 45000 }).toBeGreaterThan(before!.generation);
    const recovered = await db.collection<CallRecord>('calls').findOne({ _id: before!._id }); expect(recovered!.roomName).not.toBe(before!.roomName);
    // Use the visible controls as an operator/user would, without injecting credentials or domain state.
    for (const target of [page, other]) { await target.getByRole('button', { name: 'Stop media on this device', exact: true }).click(); await target.getByRole('button', { name: 'Join or rejoin call', exact: true }).click(); }
    await media(page); await media(other); expect((await deny()).status()).toBe(403);
    await recordMedia(page, info, 'upgrade-rejoined-owner'); await recordMedia(other, info, 'upgrade-rejoined-peer');
    expect(await provider.participants(before!.roomName)).toBeNull();
    expect((await provider.client.listRooms()).map(room => room.name)).toEqual([recovered!.roomName]);
    await writeFile(resolve('.cache', `upgrade-media-${process.env['UPGRADE_MEDIA_OWNER']}`, 'evidence.json'), JSON.stringify({ providerExitCode: 137, beforeGeneration: before!.generation, recoveredGeneration: recovered!.generation, rejoinMs: performance.now() - interruptedAt, authorizedMediaPeers: 2, outsiderDeniedBeforeAndAfter: true }));
    await page.getByRole('button', { name: 'End call for everyone', exact: true }).click();
    await expect(other.locator('.call-tracks video')).toHaveCount(0, { timeout: 20000 });
    await expect.poll(async () => (await provider.client.listRooms()).length, { timeout: 20000 }).toBe(0);
    await released(page); await released(other);
    for (const target of [page, other]) expect(await target.evaluate(() => (window as unknown as { codecCollisions: number }).codecCollisions)).toBe(0);
    console.info('Upgrade recovery: media released and codec checks passed');
    completed = true;
  } finally {
    try {
      // On a failed assertion, release only this test's native media before
      // closing its contexts. Keep the original failure visible instead of
      // letting Chromium teardown mask it. Passing cases prove SDK release above.
      if (!completed) await Promise.allSettled([page, other].map(stopCapturedMedia));
      if (killed) { await controlUpgradeMedia('start'); await expect.poll(() => provider.health(), { timeout: 30000 }).toBe(true); }
      console.info('Upgrade cleanup: closing peer context'); await second.close();
      console.info('Upgrade cleanup: peer closed, closing unauthorized context'); await unauthorized.close();
      console.info('Upgrade cleanup: auxiliary contexts closed');
    } finally { await client.close(); }
  }
});

test('publishes delayed camera capture after remote video arrives without codec collisions and releases every peer', async ({ page, browser, request }, info) => {
  // Exercise receive-before-publish ordering with bounded capture latency,
  // without delaying packets or changing the SDK's SDP.
  const context = await browser.newContext({ permissions: ['microphone', 'camera'] }), listener = await context.newPage();
  const alice = await register(request, 'codecowner'), bob = await register(request, 'codeclistener');
  let completed = false;
  try {
    await inspectMedia(page); await inspectMedia(listener);
    await listener.addInitScript(() => {
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      let release!: () => void;
      const ready = new Promise<void>(resolve => { release = resolve; });
      const gate = { requested: false, release }; Object.assign(window, { cameraGate: gate });
      navigator.mediaDevices.getUserMedia = async constraints => {
        if (constraints?.video) {
          gate.requested = true; let timer: ReturnType<typeof setTimeout> | undefined;
          try { await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Camera capture gate expired')), 60000); })]); }
          finally { clearTimeout(timer); }
        }
        return capture(constraints);
      };
    });
    await login(page, alice.email); await login(listener, bob.email);
    await search(page, bob.username); await page.getByRole('button', { name: `Open conversation with ${bob.username}`, exact: true }).click();
    await page.getByRole('button', { name: 'Video call', exact: true }).click(); await listener.getByRole('button', { name: 'Accept call', exact: true }).click();
    console.info('Late camera: call accepted');
    await expect.poll(() => listener.evaluate(() => (window as unknown as { cameraGate: { requested: boolean } }).cameraGate.requested), { timeout: 15000 }).toBe(true);
    await media(listener);
    await recordMedia(listener, info, 'late-camera-receiving');
    await expect(listener.locator('figure[data-local="true"][data-source="camera"]')).toHaveCount(0);
    await listener.evaluate(() => (window as unknown as { cameraGate: { release: () => void } }).cameraGate.release());
    await expect(listener.getByRole('button', { name: 'Turn camera off', exact: true })).toBeEnabled({ timeout: 20000 });
    console.info('Late camera: camera enabled');
    await media(page); await media(listener);
    await recordMedia(page, info, 'late-camera-owner'); await recordMedia(listener, info, 'late-camera-published');
    for (const target of [page, listener]) expect(await target.evaluate(() => (window as unknown as { codecCollisions: number }).codecCollisions)).toBe(0);
    await page.getByRole('button', { name: 'End call for everyone', exact: true }).click();
    await released(page); await released(listener);
    console.info('Late camera: media released');
    completed = true;
  } finally {
    if (!completed) await Promise.allSettled([page, listener].map(stopCapturedMedia));
    console.info('Late camera: closing context'); await context.close();
  }
});
