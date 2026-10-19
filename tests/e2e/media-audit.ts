import type { Page, TestInfo } from '@playwright/test';

export async function mediaCounters(page: Page) {
  return page.evaluate(async () => {
    const peers = (window as unknown as { __callPeers?: RTCPeerConnection[] }).__callPeers ?? [];
    const result = { peers: peers.length, connected: 0, closed: 0, videoFrames: 0, audioBytes: 0 };
    for (const peer of peers) {
      if (peer.connectionState === 'connected') result.connected++;
      if (peer.connectionState === 'closed') { result.closed++; continue; }
      for (const row of (await peer.getStats()).values()) if (row.type === 'inbound-rtp') {
        if (row.kind === 'video') result.videoFrames += row.framesDecoded ?? 0;
        if (row.kind === 'audio') result.audioBytes += row.bytesReceived ?? 0;
      }
    }
    return result;
  });
}
export async function recordMedia(page: Page, info: TestInfo, stage: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const counters = await Promise.race([mediaCounters(page), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 1500); })]);
    await info.attach(`media-${stage}`, { contentType: 'application/json', body: Buffer.from(JSON.stringify({ stage, counters })) });
    console.info('Media audit', stage, JSON.stringify(counters));
  } catch { console.info('Media audit', stage, 'unavailable'); }
  finally { if (timer) clearTimeout(timer); }
}
