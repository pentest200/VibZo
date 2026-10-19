import { Counter, Histogram, Registry } from '@prometheus-io/client';
const registry = new Registry();
const names = ['message_duplicate', 'message_dedup_conflict', 'replay_cursor_expired', 'worker_failure', 'call_reconcile_failure', 'dlq_replay'] as const;
type Event = typeof names[number];
const counters = Object.fromEntries(names.map(name => [name, new Counter({ name: `chat_${name}_total`, help: `Process-local ${name} outcomes`, registers: [registry] })])) as Record<Event, Counter>;
const lag = new Histogram({ name: 'chat_projection_publish_lag_seconds', help: 'Canonical event creation to completed Redis projection publication; not browser application latency', buckets: [0.05, 0.1, 0.3, 0.5, 1, 3, 5, 10, 30, 60, 300], registers: [registry] });
export function recordOperational(event: Event) { counters[event].inc(); }
export function observeProjectionLag(seconds: number) { if (Number.isFinite(seconds) && seconds >= 0) lag.observe(seconds); }
export const operationalMetrics = () => registry.metrics();
