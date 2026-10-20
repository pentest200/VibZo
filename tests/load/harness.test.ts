import { expect, it } from 'vitest';
import { argumentsFor, assertLocalTargets, budget, distribution, numericMetrics, profiles } from './policy.js';
import { cleanLoadEphemeral } from './cleanup.js';
import { disclosure } from './disclosure.js';
import { settleWindows } from './windows.js';
it('refuses arbitrary rate/user profiles, extra arguments, production and remote targets', () => {
  expect(argumentsFor(['combined', 'step'])).toEqual({ mode: 'combined', profile: 'step' });
  for (const args of [[], ['chat', '1000'], ['media', 'small', '--users=1000'], ['production'], ['chat', '__proto__']]) expect(() => argumentsFor(args)).toThrow();
  for (const env of [{ NODE_ENV: 'production' }, { MONGODB_URI: 'mongodb://example.com/chat' }, { REDIS_URL: 'rediss://127.0.0.1' }, { HOST: '0.0.0.0' }, { WEB_ORIGIN: 'http://other.test' }]) expect(() => assertLocalTargets(env)).toThrow();
  expect(() => assertLocalTargets({ REDIS_URL: 'redis://127.0.0.1:6379' })).not.toThrow();
  for (const profile of Object.values(profiles)) { expect(profile.rate * (budget.warmupMs + budget.measuredMs) / 1000).toBeLessThanOrEqual(128); expect(profile.chatUsers + profile.mediaUsers + 1).toBeLessThanOrEqual(12); }
});
it('uses nearest-rank percentiles with explicit empty sample results', () => {
  expect(distribution([])).toEqual({ count: 0, min: null, p50: null, p95: null, p99: null, max: null });
  const values = Array.from({ length: 100 }, (_, i) => 100 - i);
  expect(distribution(values)).toEqual({ count: 100, min: 1, p50: 50, p95: 95, p99: 99, max: 100 }); expect(values[0]).toBe(100);
  expect(() => distribution([NaN])).toThrow(); expect(() => distribution([-1])).toThrow();
});
it('retains only finite whitelisted unlabelled numeric metrics under the response bound', () => {
  const result = numericMetrics('chat_outbox_pending 3\nchat_process_resident_memory_bytes 1e8\nprivate_message{body="SECRET"} 1\nchat_outbox_pending{user="SECRET"} 9\nunknown 123\n');
  expect(result).toEqual({ chat_outbox_pending: 3, chat_process_resident_memory_bytes: 1e8 }); expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(() => numericMetrics('chat_outbox_pending -1')).toThrow(); expect(() => numericMetrics('chat_outbox_pending 1e999')).toThrow(); expect(() => numericMetrics('x'.repeat(budget.reportBytes + 1))).toThrow();
});
it('refuses ordinary and malformed Redis cleanup namespaces before opening a connection', async () => {
  for (const name of ['chat', 'chat_e2e_auth_*', 'chat_e2e_auth_1234', '../chat', 'chat_e2e_auth_' + 'a'.repeat(33)]) await expect(cleanLoadEphemeral(name)).rejects.toThrow('non-fixture');
});
it('exports bounded measurement data and refuses private identities, credentials and arbitrary fields', () => {
  const report = { mode: 'chat', profile: 'small', passed: true, chat: { acceptanceMs: { count: 2, p50: 10 } } };
  expect(JSON.parse(disclosure(report))).toMatchObject({ formatVersion: 1, ...report });
  for (const chat of [{ userId: 'private' }, { cookie: 'private' }, { body: 'private message' }, { sdp: 'private signaling' }, { data: 'person@example.test' }, { data: 'https://127.0.0.1/private' }, { data: '6a95082f-f650-42a0-8da1-689f87c3d411' }]) expect(() => disclosure({ ...report, chat })).toThrow();
  expect(() => disclosure({ ...report, unexpected: 'private' })).toThrow(); expect(() => disclosure({ ...report, chat: { value: Infinity } })).toThrow();
});
it('bounds artifact arrays, nested objects and total disclosure bytes', () => {
  const report = { mode: 'media', profile: 'small', passed: false };
  expect(() => disclosure({ ...report, media: { samples: Array(513).fill(0) } })).toThrow();
  let deep: unknown = 0; for (let i = 0; i < 14; i++) deep = { data: deep };
  expect(() => disclosure({ ...report, media: deep })).toThrow();
  expect(() => disclosure({ ...report, media: Array(512).fill('x'.repeat(2048)) })).toThrow();
});
it('stops sibling generation on failure but holds cleanup until its admitted write settles', async () => {
  let release!: () => void, stopped!: () => void, cleaned = false;
  const stopObserved = new Promise<void>(resolve => { stopped = resolve; });
  const admitted = new Promise<void>(resolve => { release = resolve; }).then(() => ({ startMs: 1, endMs: 2 }));
  const failure = new Error('transport failed');
  const result = settleWindows([admitted, Promise.reject(failure)], stopped).then(outcomes => { cleaned = true; return outcomes; });
  await stopObserved;
  expect(cleaned).toBe(false);
  release();
  expect(await result).toEqual([{ status: 'fulfilled', value: { startMs: 1, endMs: 2 } }, { status: 'rejected', reason: failure }]);
  expect(cleaned).toBe(true);
});
