import { expect } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import { loadConfig } from '@chat/config';
import { LiveKitProvider } from '@chat/domain';
import { setTimeout as pause } from 'node:timers/promises';
import { actor, group } from './actors.js';
import type { Actor } from './actors.js';
import { login } from '../e2e/chat-fixture.js';
import { distribution, profiles } from './policy.js';
import type { Profile } from './policy.js';

async function instrument(page: Page) {
  await page.addInitScript(() => {
    const Original = window.RTCPeerConnection, peers: RTCPeerConnection[] = [], tracks: MediaStreamTrack[] = [];
    Object.assign(window, { loadPeers: peers, loadTracks: tracks });
    window.RTCPeerConnection = class extends Original { constructor(config?: RTCConfiguration) { super(config); peers.push(this); } };
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => { const stream = await capture(constraints); tracks.push(...stream.getTracks()); return stream; };
  });
}
async function counters(page: Page) {
  return page.evaluate(async () => {
    const { loadPeers: peers } = window as unknown as { loadPeers: RTCPeerConnection[] };
    const result = { peers: peers.length, connectionStates: peers.map(peer => peer.connectionState), iceStates: peers.map(peer => peer.iceConnectionState), connected: 0, frames: 0, audioBytes: 0, receivedBytes: 0, sentBytes: 0, lostPackets: 0, jitterSeconds: null as number | null, rttSeconds: null as number | null, availableOutgoingBps: null as number | null, routes: [] as string[] };
    const routes = new Set<string>();
    for (const peer of peers) {
      if (peer.connectionState !== 'connected') continue; result.connected++;
      const report = await peer.getStats();
      for (const row of report.values()) {
        if (row.type === 'inbound-rtp') { result.frames += row.framesDecoded ?? 0; result.receivedBytes += row.bytesReceived ?? 0; if (row.kind === 'audio') result.audioBytes += row.bytesReceived ?? 0; result.lostPackets += Math.max(0, row.packetsLost ?? 0); if (typeof row.jitter === 'number') result.jitterSeconds = Math.max(result.jitterSeconds ?? 0, row.jitter); }
        if (row.type === 'outbound-rtp') result.sentBytes += row.bytesSent ?? 0;
        if (row.type === 'candidate-pair' && row.nominated && row.state === 'succeeded') {
          if (typeof row.currentRoundTripTime === 'number') result.rttSeconds = Math.max(result.rttSeconds ?? 0, row.currentRoundTripTime);
          if (typeof row.availableOutgoingBitrate === 'number') result.availableOutgoingBps = Math.max(result.availableOutgoingBps ?? 0, row.availableOutgoingBitrate);
          const candidate = report.get(row.localCandidateId); if (candidate) routes.add(candidate.candidateType === 'relay' ? 'relay' : 'direct');
        }
      }
    }
    result.routes = [...routes].sort(); return result;
  });
}
export async function mediaLoad(request: APIRequestContext, browser: Browser, profile: Profile, guard: () => void, setupFailure: (diagnostics: unknown) => void) {
  const actors: Actor[] = [], contexts: BrowserContext[] = [], pages: Page[] = [], setupMs: number[] = [], connectedMs: number[] = [], firstRemoteReadyMs: number[] = [];
  const samples: { elapsedMs: number; peers: Awaited<ReturnType<typeof counters>>[] }[] = [];
  const observations: { user: number; elapsedMs: number; status?: number; generation?: number; ready?: boolean; state?: string; joined?: number }[] = [];
  const observedAt = performance.now();
  const provider = new LiveKitProvider(loadConfig({ ...process.env, NODE_ENV: 'test' }));
  const close = async () => {
    for (const page of pages) if (!page.isClosed()) await page.evaluate(() => {
      const state = window as unknown as { loadTracks?: MediaStreamTrack[]; loadPeers?: RTCPeerConnection[] };
      for (const track of state.loadTracks ?? []) track.stop(); for (const peer of state.loadPeers ?? []) peer.close();
    }).catch(() => {});
    await Promise.allSettled(contexts.map(context => context.close())); await Promise.allSettled(actors.map(actor => actor.api.dispose()));
  };
  try {
    for (let n = 0; n < profiles[profile].mediaUsers; n++) { guard(); actors.push(await actor(request, `loadmedia${n}`)); }
    const conversationId = await group(actors);
    for (const user of actors) {
      guard();
      const context = await browser.newContext({ permissions: ['microphone', 'camera'] }); contexts.push(context);
      const page = await context.newPage(); pages.push(page); const index = pages.length - 1; let previous = '';
      page.on('response', response => {
        const path = new URL(response.url()).pathname;
        if (!path.startsWith('/api/v1/calls')) return;
        if (response.status() >= 400 && observations.length < 128) observations.push({ user: index, elapsedMs: performance.now() - observedAt, status: response.status() });
        if (response.status() !== 200 || !/^\/api\/v1\/calls\/[^/]+$/.test(path)) return;
        void response.json().then((raw: unknown) => {
          const call = raw as { generation?: unknown; ready?: unknown; state?: unknown; participants?: { joined?: unknown }[] };
          if (typeof call.generation !== 'number' || typeof call.ready !== 'boolean' || typeof call.state !== 'string' || !['ringing', 'active', 'ending', 'ended', 'cancelled', 'timed_out'].includes(call.state) || !Array.isArray(call.participants)) return;
          const value = { generation: call.generation, ready: call.ready, state: call.state, joined: call.participants.filter(part => part.joined === true).length }, key = JSON.stringify(value);
          if (key !== previous && observations.length < 128) { previous = key; observations.push({ user: index, elapsedMs: performance.now() - observedAt, ...value }); }
        }).catch(() => {});
      });
      await instrument(page); await login(page, user.email); await page.goto(`/chat/${conversationId}`);
      await expect(page.getByRole('button', { name: 'Video call', exact: true })).toBeEnabled();
    }
    const start = performance.now(); await pages[0]!.getByRole('button', { name: 'Video call', exact: true }).click();
    for (const page of pages.slice(1)) await page.getByRole('button', { name: 'Accept call', exact: true }).click();
    await Promise.all(pages.map(async page => {
      await expect(page.getByRole('status', { name: 'Media connection', exact: true })).toHaveText('connected', { timeout: 30000 });
      connectedMs.push(performance.now() - start);
      const remote = page.locator('figure[data-local="false"] video'); await expect(remote.first()).toBeAttached({ timeout: 20000 }); await remote.first().scrollIntoViewIfNeeded();
      await expect.poll(() => remote.evaluateAll(nodes => nodes.filter(node => (node as HTMLVideoElement).videoWidth > 0 && (node as HTMLVideoElement).readyState >= 2).length), { timeout: 20000 }).toBe(pages.length - 1);
      firstRemoteReadyMs.push(performance.now() - start);
      await expect.poll(async () => (await counters(page)).frames, { timeout: 20000 }).toBeGreaterThan(5);
      await expect.poll(async () => (await counters(page)).audioBytes, { timeout: 20000 }).toBeGreaterThan(100);
      setupMs.push(performance.now() - start);
    }));
    guard();
  } catch (error) {
    const native = await Promise.all(pages.map(page => counters(page).catch(() => null)));
    setupFailure({ observations, native, connectedMs, firstRemoteReadyMs, validatedMediaMs: setupMs });
    await close(); throw error;
  }
  return {
    close,
    async measure(ms: number) {
      const started = performance.now(), capture = async () => { guard(); const peers = await Promise.all(pages.map(counters)); samples.push({ elapsedMs: performance.now() - started, peers }); if (peers.some(peer => peer.connected !== 2)) throw new Error('Media transport count or disconnection'); };
      while (performance.now() < started + ms) { await capture(); await pause(Math.min(2000, Math.max(0, started + ms - performance.now()))); }
      await capture();
      for (let user = 0; user < pages.length; user++) {
        const before = samples[0]!.peers[user]!, after = samples.at(-1)!.peers[user]!;
        if (after.frames <= before.frames || after.audioBytes <= before.audioBytes || after.sentBytes <= before.sentBytes) throw new Error('Media stopped advancing during measured window');
      }
      return { startMs: started, endMs: performance.now() };
    },
    async finish() {
      await pages[0]!.getByRole('button', { name: 'End call for everyone', exact: true }).click();
      for (const page of pages) await expect.poll(() => page.evaluate(() => {
        const { loadPeers: peers, loadTracks: tracks } = window as unknown as { loadPeers: RTCPeerConnection[]; loadTracks: MediaStreamTrack[] };
        return peers.length > 0 && tracks.length > 0 && peers.every(peer => peer.connectionState === 'closed') && tracks.every(track => track.readyState === 'ended');
      }), { timeout: 15000 }).toBe(true);
      await expect.poll(async () => (await provider.client.listRooms()).length, { timeout: 15000 }).toBe(0);
      return { nativeMediaReleased: true, roomsAfterEnd: 0 };
    },
    summary() {
      // Keep the failing observation, but never derive bitrate across a reset or
      // disconnected counter. Such a trial remains censored, even if it recovers.
      const connected = samples.filter(sample => sample.peers.every(peer => peer.connected === 2));
      const first = connected[0], last = connected.at(-1), seconds = first && last ? (last.elapsedMs - first.elapsedMs) / 1000 : 0;
      const users = pages.map((_, index) => { const a = first?.peers[index], b = last?.peers[index]; return { receivedKbitPerSecond: a && b && seconds ? Math.max(0, b.receivedBytes - a.receivedBytes) * 8 / 1000 / seconds : null, sentKbitPerSecond: a && b && seconds ? Math.max(0, b.sentBytes - a.sentBytes) * 8 / 1000 / seconds : null }; });
      return { users: pages.length, observations, setupToConnectedMs: distribution(connectedMs), setupToRemoteReadyObservedMs: distribution(firstRemoteReadyMs), setupToValidatedMediaMs: distribution(setupMs), setupBoundary: 'from owner call click; readiness observed by polling, validated media requires >5 decoded frames and >100 audio bytes', setupSampleLimit: '2 or 3 samples do not establish tail reliability', capture: { requestedWidth: 640, requestedHeight: 360, requestedFps: 20, generated: true }, bitrateBoundary: 'RTC RTP byte-counter deltas; excludes wire/transport overhead and is not billed bandwidth', usersBitrate: users, samples, browserRss: 'unavailable', hardwareAndForcedTurnVerified: false };
    },
  };
}
