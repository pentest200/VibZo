import { Histogram, Gauge, Counter } from '@prometheus-io/client';
import type { Registry } from '@prometheus-io/client';
export function httpMetrics(registry: Registry) {
  const duration = new Histogram({ name: 'chat_http_request_duration_seconds', help: 'HTTP duration through response, seconds', labelNames: ['method', 'route', 'status'] as const, buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.3, 0.5, 1, 3, 5, 10], registers: [registry] });
  const active = new Gauge({ name: 'chat_http_inflight', help: 'Accepted requests not yet completed', registers: [registry] });
  const draining = new Gauge({ name: 'chat_process_draining', help: 'Process has stopped admitting new work', registers: [registry] });
  const rejected = new Counter({ name: 'chat_drain_rejections_total', help: 'Requests rejected while draining', registers: [registry] });
  return { duration, active, draining, rejected };
}
