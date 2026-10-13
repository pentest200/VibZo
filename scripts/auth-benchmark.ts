import { cpus, totalmem, platform } from 'node:os';
import { performance } from 'node:perf_hooks';
import { loadConfig } from '@chat/config';
import { PasswordHasher } from '@chat/domain';
const config = loadConfig(); const hasher = new PasswordHasher(config);
await hasher.initialize();
const samples: number[] = [];
for (let i = 0; i < 5; i++) { const start = performance.now(); await hasher.hash('synthetic-benchmark-password'); samples.push(performance.now() - start); }
const start = performance.now();
await Promise.all(Array.from({ length: config.AUTH_HASH_CONCURRENCY }, () => hasher.hash('synthetic-benchmark-password')));
console.log(JSON.stringify({ hardware: { platform: platform(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramGiB: totalmem() / 2 ** 30 },
  node: process.version, argon2: { variant: 'argon2id', memoryKiB: config.ARGON_MEMORY_KIB, timeCost: config.ARGON_TIME_COST, parallelism: config.ARGON_PARALLELISM,
    concurrency: config.AUTH_HASH_CONCURRENCY, maximumHashWorkingMemoryMiB: config.ARGON_MEMORY_KIB * config.AUTH_HASH_CONCURRENCY / 1024 }, warmupHashes: 1, sampleMs: samples,
  concurrentBatchMs: performance.now() - start, rssMiB: process.memoryUsage().rss / 2 ** 20 }, null, 2));
