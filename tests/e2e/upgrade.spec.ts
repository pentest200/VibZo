import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { loadConfig } from '@chat/config';
import { createMongoClient, LiveKitProvider } from '@chat/domain';
import type { CallRecord } from '@chat/domain';
import { login, register, search } from './chat-fixture.js';
import { controlUpgradeMedia } from '../integration/upgrade-media.js';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function media(page: Page) {
  await expect(page.getByRole('status', { name: 'Media connection', exact: true })).toHaveText('connected', { timeout: 45000 });
  // Adaptive video pauses off-screen subscriptions after the rejoin controls scroll the page.
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
async function inspectMedia(page: Page) { await page.addInitScript(() => { const Original = window.RTCPeerConnection, peers: RTCPeerConnection[] = []; Object.assign(window, { upgradePeers: peers }); window.RTCPeerConnection = class extends Original { constructor(config?: RTCConfiguration) { super(config); peers.push(this); } }; }); }
test('survives a killed SFU, rotates its room and visibly rejoins only authorized users with real media', async ({ page, browser, request }) => {
  const alice = await register(request, 'upgradealice'), bob = await register(request, 'upgradebob'), outsider = await register(request, 'upgradeoutsider');
  const second = await browser.newContext({ permissions: ['microphone', 'camera'] }), other = await second.newPage();
  const unauthorized = await browser.newContext(), stranger = await unauthorized.newPage();
  const config = loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: process.env['E2E_DATABASE'] }), client = createMongoClient(config), db = client.db(config.MONGODB_DATABASE), provider = new LiveKitProvider(config);
  let killed = false;
  try {
    await client.connect(); await inspectMedia(page); await inspectMedia(other);
    await login(page, alice.email); await login(other, bob.email); await login(stranger, outsider.email);
    await search(page, bob.username); await page.getByRole('button', { name: `Open conversation with ${bob.username}`, exact: true }).click();
    await page.getByRole('button', { name: 'Video call', exact: true }).click(); await other.getByRole('button', { name: 'Accept call', exact: true }).click();
    await media(page); await media(other);
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
    expect(await provider.participants(before!.roomName)).toBeNull();
    expect((await provider.client.listRooms()).map(room => room.name)).toEqual([recovered!.roomName]);
    await writeFile(resolve('.cache', `upgrade-media-${process.env['UPGRADE_MEDIA_OWNER']}`, 'evidence.json'), JSON.stringify({ providerExitCode: 137, beforeGeneration: before!.generation, recoveredGeneration: recovered!.generation, rejoinMs: performance.now() - interruptedAt, authorizedMediaPeers: 2, outsiderDeniedBeforeAndAfter: true }));
    await page.getByRole('button', { name: 'End call for everyone', exact: true }).click();
    await expect(other.locator('.call-tracks video')).toHaveCount(0, { timeout: 20000 });
    await expect.poll(async () => (await provider.client.listRooms()).length, { timeout: 20000 }).toBe(0);
  } finally { if (killed) { await controlUpgradeMedia('start'); await expect.poll(() => provider.health(), { timeout: 30000 }).toBe(true); } await second.close(); await unauthorized.close(); await client.close(); }
});
