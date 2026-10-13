# Optional observability profile

Phase 00 exposes process metrics and redacted Pino logs. OTel currently provides only a tracer seam, without an SDK/exporter. Prometheus/Grafana/OTel collection, dashboards, alerts, correlation and fault validation belong to Phase 08; no heavy telemetry containers start by default.
