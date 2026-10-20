import { freemem, totalmem, cpus, platform, release } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { budget, numericMetrics } from './policy.js';
const execute = promisify(execFile);
export const hostInventory = () => ({ platform: platform(), release: release(), cpuModel: cpus()[0]?.model ?? 'unavailable', logicalProcessors: cpus().length, memoryBytes: totalmem(), freeBytesAtCapture: freemem(), node: process.versions.node, generatorLocation: 'same Windows host as application and Docker VM' });
export function runtimeSampler(media: boolean) {
  const samples: { elapsedMs: number; freeHostBytes: number; generatorRssBytes: number; roles: Record<string, Record<string, number>>; sfu: { cpuPercent: number; memoryUsage: string } | null }[] = [];
  const lag = monitorEventLoopDelay({ resolution: 20 }); lag.enable();
  const started = performance.now(); let failure: string | null = null, stopped = false, active: Promise<void> | undefined;
  const capture = () => active ??= (async () => {
    try {
      if (samples.length >= budget.maxSamples) throw new Error('sample_budget');
      const roles: Record<string, Record<string, number>> = {};
      for (const [role, port] of [['api', 3000], ['gateway', 3001], ['worker', 3002]] as const) {
        const response = await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(3000) });
        if (!response.ok) throw new Error('metrics_unavailable');
        const reader = response.body?.getReader(); if (!reader) throw new Error('metrics_unavailable');
        const chunks: Uint8Array[] = []; let size = 0;
        try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > budget.reportBytes) throw new Error('metrics_bound'); chunks.push(value); } }
        finally { await reader.cancel(); }
        roles[role] = numericMetrics(Buffer.concat(chunks).toString());
        const metrics = roles[role]!;
        if (!('chat_process_resident_memory_bytes' in metrics)) throw new Error('metrics_missing_rss');
        if (metrics['chat_process_resident_memory_bytes']! > budget.appRss) throw new Error('app_memory_budget');
        for (const key of ['chat_outbox_pending', 'chat_fanout_pending', 'chat_gateway_hint_queue']) if ((metrics[key] ?? 0) > budget.maxBacklog) throw new Error('backlog_budget');
      }
      const freeHostBytes = freemem(), generatorRssBytes = process.memoryUsage().rss;
      if (freeHostBytes < budget.minFreeBytes || generatorRssBytes > budget.generatorRss) throw new Error('host_memory_budget');
      let sfu = null;
      if (media && samples.length % 2 === 0) {
        const name = process.env['UPGRADE_MEDIA_NAME']; if (!/^commonroom-upgrade-media-[a-f0-9]{12}$/.test(name ?? '')) throw new Error('sfu_identity');
        const { stdout } = await execute('docker', ['--config', '.cache/docker', 'stats', '--no-stream', '--format', '{{json .}}', name!], { windowsHide: true, timeout: 5000, maxBuffer: 32768 });
        const raw = JSON.parse(stdout) as { CPUPerc: string; MemUsage: string };
        const cpuPercent = Number(raw.CPUPerc.replace('%', '')); if (!Number.isFinite(cpuPercent) || !/^[\d.]+[kMGT]?i?B \/ [\d.]+[kMGT]?i?B$/.test(raw.MemUsage)) throw new Error('sfu_metrics');
        sfu = { cpuPercent, memoryUsage: raw.MemUsage };
      }
      samples.push({ elapsedMs: Math.round(performance.now() - started), freeHostBytes, generatorRssBytes, roles, sfu });
    } catch (error) {
      const known = ['sample_budget', 'metrics_unavailable', 'metrics_bound', 'metrics_missing_rss', 'app_memory_budget', 'backlog_budget', 'host_memory_budget', 'sfu_identity', 'sfu_metrics'];
      failure ??= error instanceof Error && known.includes(error.message) ? error.message : 'runtime_capture_failed';
    }
    finally { active = undefined; }
  })();
  const timer = setInterval(() => { if (!stopped) void capture(); }, 2000);
  return {
    capture,
    check() { if (failure) throw new Error(failure); },
    async close() { stopped = true; clearInterval(timer); if (active) await active; lag.disable(); return { startMs: started, endMs: performance.now(), samples, failure, generatorEventLoopMs: { count: lag.count, p50: lag.count ? lag.percentile(50) / 1e6 : null, p95: lag.count ? lag.percentile(95) / 1e6 : null, p99: lag.count ? lag.percentile(99) / 1e6 : null, max: lag.count ? lag.max / 1e6 : null } }; },
  };
}
