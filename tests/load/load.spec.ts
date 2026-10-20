import { test, expect } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { loadConfig } from '@chat/config';
import { createMongoClient } from '@chat/domain';
import { argumentsFor, budget, numericMetrics, profiles } from './policy.js';
import { hostInventory, runtimeSampler } from './runtime.js';
import { chatLoad } from './chat.js';
import { mediaLoad } from './media.js';
import { freemem } from 'node:os';
import { settleWindows } from './windows.js';
async function saveReport(report: Record<string, unknown>) {
  const json = JSON.stringify(report, null, 2); if (Buffer.byteLength(json) > budget.reportBytes) throw new Error('Load report exceeded bound');
  await writeFile(resolve(process.env['LOAD_DIRECTORY']!, 'measurement.json'), json, { mode: 0o600 });
}

test('bounded real chat/media measurement with canonical invariants and owned cleanup', async ({ request, browser }) => {
  const { mode, profile } = argumentsFor([process.env['LOAD_MODE']!, process.env['LOAD_PROFILE']!]);
  let chat: Awaited<ReturnType<typeof chatLoad>> | undefined, media: Awaited<ReturnType<typeof mediaLoad>> | undefined, runtime: ReturnType<typeof runtimeSampler> | undefined;
  let passed = false, runtimeResult: Awaited<ReturnType<ReturnType<typeof runtimeSampler>['close']>> | undefined;
  let stage = 'setup';
  let windowFailed = false;
  const guard = () => { if (windowFailed) throw new Error('Concurrent load window stopped'); if (freemem() < budget.minFreeBytes || process.memoryUsage().rss > budget.generatorRss) throw new Error('Load host/generator memory safeguard'); runtime?.check(); };
  const report: Record<string, unknown> = { mode, profile, profileLimits: profiles[profile], warmupMs: budget.warmupMs, measuredMs: budget.measuredMs, host: hostInventory(), topology: 'single compiled API/gateway/worker, stable Vite development web, shared single-node Docker dependencies, private SFU 1 CPU/512 MiB, all colocated', admission: 'unchanged product limits; distinct real loopback TCP source per REST actor, shared loopback for socket/browser traffic', unavailable: ['production capacity', 'independent-host network', 'physical devices', 'forced TURN', 'browser RSS', 'production assets/CDN'] };
  report['inventory'] = JSON.parse(await readFile(resolve(process.env['LOAD_DIRECTORY']!, 'inventory.json'), 'utf8')) as unknown;
  try {
    if (mode !== 'media') chat = await chatLoad(request, profile, guard);
    if (mode !== 'chat') media = await mediaLoad(request, browser, profile, guard, diagnostics => { report['mediaSetupFailure'] = diagnostics; });
    runtime = runtimeSampler(mode !== 'chat'); await runtime.capture(); runtime.check();
    stage = 'warmup';
    await Promise.all([chat?.window(budget.warmupMs, false), pause(budget.warmupMs)]);
    stage = 'measured';
    const measuredStart = performance.now();
    // A failure stops new work in its sibling. Await both bounded tasks before
    // closing sockets/media or letting the reporter delete their fixture.
    const windows = await settleWindows([chat?.window(budget.measuredMs, true), media?.measure(budget.measuredMs)], () => { windowFailed = true; });
    const chatWindow = windows[0]!.status === 'fulfilled' ? windows[0]!.value : undefined, mediaWindow = windows[1]!.status === 'fulfilled' ? windows[1]!.value : undefined;
    report['windows'] = { chat: chatWindow ?? null, media: mediaWindow ?? null, rejected: windows.map(result => result.status === 'rejected'), measuredStartMs: measuredStart, clock: 'same generator performance.now() milliseconds; chat end includes bounded live-reference drain' };
    for (const result of windows) if (result.status === 'rejected') throw result.reason;
    runtime.check(); await runtime.capture(); runtimeResult = await runtime.close(); runtime.check();
    stage = 'invariants';
    if (chatWindow && mediaWindow) expect(Math.min(chatWindow.endMs, mediaWindow.endMs) - Math.max(chatWindow.startMs, mediaWindow.startMs)).toBeGreaterThanOrEqual(10000);
    report['chatInvariants'] = await chat?.verify() ?? null; report['mediaInvariants'] = await media?.finish() ?? null;
    await expect.poll(async () => { const response = await request.get('http://127.0.0.1:3002/metrics'); const metrics = numericMetrics(await response.text()); return [metrics['chat_outbox_pending'], metrics['chat_fanout_pending']]; }, { timeout: 15000 }).toEqual([0, 0]);
    // Read only the just-claimed fixture and verify its durable count. Never use
    // an environment-supplied ordinary DB as a fallback.
    const database = process.env['E2E_DATABASE']!; if (!/^chat_e2e_auth_[a-f0-9]{32}$/.test(database)) throw new Error('Load DB identity invalid');
    const client = createMongoClient(loadConfig({ ...process.env, NODE_ENV: 'test', MONGODB_DATABASE: database }));
    try { await client.connect(); const db = client.db(database), owner = await db.collection<{ _id: string; runId: string }>('e2eFixtureOwner').findOne({ _id: 'playwright' }); if (owner?.runId !== process.env['E2E_RUN_ID']) throw new Error('Load DB owner mismatch'); const count = await db.collection('messages').countDocuments(); expect(count).toBe(chat?.summary().accepted ?? 0); report['durableMessageCount'] = count; }
    finally { await client.close(); }
    passed = true;
  } finally {
    if (runtime && !runtimeResult) runtimeResult = await runtime.close();
    report['passed'] = passed; report['failedStage'] = passed ? null : stage; report['runtime'] = runtimeResult ?? null; report['chat'] = chat?.summary() ?? null; report['media'] = media?.summary() ?? null;
    try { await media?.close(); } finally { await chat?.close(); }
    await saveReport(report);
  }
});
