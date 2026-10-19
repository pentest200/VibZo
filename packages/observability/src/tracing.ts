import { context, propagation, trace, ROOT_CONTEXT, SpanStatusCode, isSpanContextValid, diag } from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import type { Attributes, Span } from '@opentelemetry/api';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { BatchSpanProcessor, TraceIdRatioBasedSampler } from '@opentelemetry/sdk-trace-base';

export interface TraceSettings { OTEL_TRACE_ENABLED: boolean; OTEL_TRACE_SAMPLE_RATIO: number; OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: string }
export function startTelemetry(service: 'api' | 'gateway' | 'worker', config: TraceSettings) {
  if (!config.OTEL_TRACE_ENABLED) return { async close() {}, async flush() {} };
  const exporter = new OTLPTraceExporter({ url: config.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, timeoutMillis: 1500, concurrencyLimit: 1 });
  const processor = new BatchSpanProcessor(exporter, { maxQueueSize: 256, maxExportBatchSize: 32, scheduledDelayMillis: 1000, exportTimeoutMillis: 2000 });
  const sdk = new NodeSDK({ serviceName: `commonroom-${service}`, autoDetectResources: false, sampler: new TraceIdRatioBasedSampler(config.OTEL_TRACE_SAMPLE_RATIO), spanProcessors: [processor], instrumentations: [], logRecordProcessors: [], metricReaders: [], textMapPropagator: new W3CTraceContextPropagator() });
  // SDK diagnostics may serialize raw exporter errors/URLs when env enables debug.
  // Application logs expose classifications; exporter failures remain best-effort.
  diag.disable();
  sdk.start();
  return { async close() { await sdk.shutdown().catch(() => {}); }, async flush() { await processor.forceFlush().catch(() => {}); } };
}
const parentPattern = /^00-(?!0{32}-)[a-f0-9]{32}-(?!0{16}-)[a-f0-9]{16}-0[01]$/;
export function safeTraceparent(value: unknown): string | undefined { return typeof value === 'string' && parentPattern.test(value) ? value : undefined; }
export function traceCarrier(): Record<string, string> {
  const carrier: Record<string, string> = {}; propagation.inject(context.active(), carrier);
  const parent = safeTraceparent(carrier['traceparent']); return parent ? { traceparent: parent } : {};
}
export function traceFields() {
  const active = trace.getSpan(context.active())?.spanContext();
  return active && isSpanContextValid(active) ? { traceId: active.traceId, spanId: active.spanId } : {};
}
export async function traced<T>(name: string, attributes: Attributes, operation: () => Promise<T>, parent?: unknown): Promise<T> {
  const valid = safeTraceparent(parent), base = valid ? propagation.extract(ROOT_CONTEXT, { traceparent: valid }) : context.active();
  return trace.getTracer('commonroom').startActiveSpan(name, { attributes }, base, async span => {
    try { return await operation(); }
    catch (error) { span.setStatus({ code: SpanStatusCode.ERROR }); throw error; }
    finally { span.end(); }
  });
}
// Fastify callback hooks explicitly establish async context for the rest of the request.
export function beginRequestSpan(method: string, route: string, next: () => void): Span {
  const span = trace.getTracer('commonroom').startSpan('http.request', { attributes: { 'http.request.method': method, 'http.route': route } }, ROOT_CONTEXT);
  context.with(trace.setSpan(ROOT_CONTEXT, span), next); return span;
}
