# Operations: Phase 08 work in progress

Only the executed scope in [Phase 08 evidence](../phase-08-evidence.md) is verified. Telemetry/fault checks, encrypted restore, and overlapping-release drills have separate gates in [the implementation plan](../../implementation_plan.md). Phase 06 native push and Phase 07 end-to-end forced TURN remain open. This document describes local implemented controls and a proposed production topology, not a deployed environment.

## Implemented tracing and metrics

Build first. Set these server-only environment variables on **each** API, gateway and worker process when a trusted collector is available:

```text
OTEL_TRACE_ENABLED=true
OTEL_TRACE_SAMPLE_RATIO=0.1
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:4318/v1/traces
```

Tracing defaults off. Production requires an explicit HTTPS collector. These settings do not start the collector; use the optional local profile below. No frontend `VITE_*` telemetry secrets. Runtime collector credentials belong in the process environment/secret manager; restrict collector access. Do not enable verbose SDK diagnostics in an environment containing credentials.

Manual spans cover HTTP acceptance, outbox publication, broker consumption/retry, Redis fanout, gateway dispatch and bounded worker job categories. HTTP starts a fresh server context; arbitrary browser trace headers and baggage cannot select a trace. Only a validated W3C v00 `traceparent` is persisted on an outbox record after migration `008_operations`, or propagated in AMQP headers. Strict v1 JSON envelopes remain unchanged. Fanout and gateway look up durable context using the event reference; Redis payloads remain unchanged. Old rows without context remain valid. Trace metadata follows the existing outbox retention policy; it is not a separate indefinite event ledger.

Enable tracing on every role to observe the complete chain. Sampling is deterministic by trace ID. A sampled span may be dropped when its bounded 256-span queue is full; batches contain at most 32 spans, one export request runs at a time, request timeout is 1.5 seconds and processor export timeout is 2 seconds. Export failure does not roll back an accepted command or acknowledge an uncommitted effect. No automatic HTTP/DB instrumentation, resource/environment/command-line detection, request/response bodies, query strings, user IDs, private URLs, raw exceptions, SDP or device information are captured. Structured application logs include active trace/span IDs and retain redaction. Logs classify errors; they do not serialize transport/provider error objects.

`/metrics` remains private to each role. API `chat_http_request_duration_seconds` labels contain method, route **template** and status only. Use its buckets for p50/p95/p99; an HTTP duration includes request handling through response, not browser-to-browser delivery latency. `chat_http_inflight`, `chat_process_draining` and `chat_drain_rejections_total` describe HTTP admission. Gateway exposes in-flight owned work, socket/hint/ACK counts. Worker exposes in-flight jobs and existing durable backlog/failure/call gauges. `chat_mongo_pool_*` counts connections, checked-out connections, checkout waiters/failures and pool clears across that process's Mongo client; these are driver lifecycle measurements, not replica lag or fleet capacity. Existing process metrics include event-loop and memory data. Never add user/conversation/event IDs or endpoint URLs as metric labels.

The 08A operations suite uses a bounded in-memory HTTP collector fixture. The 08B dependency suite uses the actual pinned collector, Prometheus and Alertmanager described below. Neither establishes production availability or capacity.

## Optional local telemetry profile

Build shared packages and start the normal dependencies, scanner and media first. From the repository root:

```text
pnpm build
pnpm infra:telemetry
pnpm ops:telemetry
```

Keep `ops:telemetry` running in its own terminal while the application runs. The CLI inherits environment variables; it does not auto-load `.env`. For a file, use `node --env-file=.env --import tsx scripts/telemetry-agent.ts`. Enable tracing separately on each application process as above. Open Prometheus at `http://127.0.0.1:9090`, Alertmanager at `http://127.0.0.1:9093`; OTLP/HTTP is `http://127.0.0.1:4318/v1/traces`. These interfaces have no application authentication and must remain local/private. `TELEMETRY_*_PORT` overrides belong in the CLI/Compose environment; update the SDK endpoint when changing OTLP's port.

The host agent inspects only loopback targets and refuses production mode. It reads fixed role metrics/health endpoints and bounded dependency protocols; it writes atomic snapshots under `infra/compose/.runtime/telemetry` (or `TELEMETRY_RUNTIME_DIR` inside workspace `.cache/` or `infra/compose/.runtime/`). A lock prevents concurrent agents using one directory. Graceful exit releases the lock. After an abnormal stop, verify no agent is running before removing that directory's `agent.lock`. Snapshot replacement retries Windows sharing errors for at most 450ms; a persistent write failure stops the agent and freshness alerts expose the loss.

The internal relay mounts snapshots read-only. Prometheus scrapes it every 5s, with 2s scrape deadlines and fixed role labels. A snapshot older than 30s is unavailable: old dependency metrics disappear instead of repeating success. Application metric failures remain fresh explicit `chat_role_scrape_up=0`, with independent liveness/readiness observations. Probe deadlines are 100–3000ms (default 1000), intervals 1000–10000ms (default 5000), with one capture in flight. Failed probes back off after three failures, capped at 30s plus <100ms jitter. Mongo inspection has two pool slots; queue queries and HTTP/metric bodies have finite limits. A single-node replica reports secondary lag **unobserved**, not proven zero lag. SMTP probes only greeting/EHLO/QUIT; push provider delivery remains unobserved even if configured.

Pinned images are Prometheus 3.15.0, Alertmanager 0.34.1 and contrib collector 0.163.1, with exact digests in Compose. The relay uses the existing pinned Node 24.21.0 base, no additional packages, UID 10001, read-only root and no capabilities. Profile limits total 1 GiB container memory plus bounded tmpfs stores; CPU ceilings total 2 cores. Allow additional Docker host overhead and spare memory beyond the baseline services; this is an allocation budget, not a measured minimum or capacity result.

Relay/alert sink has no host port and stays on the internal observing network. The collector, Prometheus and Alertmanager also join a dedicated bridge so Docker publishes their explicit **127.0.0.1** ports; an internal-only network omitted effective host mappings on this Docker Desktop engine. No host-gateway scrape or application bind change. Inspect actual Docker mappings when port access fails. The extra bridge is not an enforced production egress-deny policy.

Prometheus uses tmpfs, 2h/128MB TSDB retention, 384MiB storage and 16MiB test temporary space, bounded queries/samples/connections; retention is not a total RAM limit. Alertmanager stores at most 2h state in 8MiB tmpfs. Its only receiver is the internal relay, which retains at most 100 sanitized firing/resolved records and accepts at most 50 alerts/64KiB per request. There is no external notification integration.

The collector accepts at most 1MiB HTTP requests, applies memory limits, filters fixed services/span names, rejects linked spans, removes events/unapproved attributes/status text/tracestate, then batches at most 64 spans. Manual application spans have no links. File output rotates at 8MiB with two backups in a 32MiB shared local-driver tmpfs volume; the relay mounts it read-only for operator/test inspection. No trace HTTP download route is exposed. Both processes use UID 10001 and directory mode 0700. Docker `cp` did not expose live tmpfs contents here; tests read the actual file through the readonly reader. `max_days: 1` prunes rotated files; it does **not** guarantee that an active file expires after 24h. Trace data disappears after the last mount stops; tmpfs may be swapped by the host, so this is not cryptographic erasure or durable incident storage. Copied test artifacts under `.cache/` remain until explicitly removed. Production needs separately managed access, retention, encryption and incident storage.

Run `pnpm test:failure:dependencies` after `pnpm infra:telemetry` has built/pulled the tools. The suite starts its own uniquely named telemetry project and isolated application database, creates local TCP fault proxies, launches separate compiled API/gateway/worker roles, then checks actual collector output and real Prometheus → Alertmanager → internal sink firing/resolved events. It removes only its guarded project/volume and fixture database. Linux CI prepares the same images explicitly; a configured CI job is not a remote passing run.

Stop the agent with Ctrl+C. To stop only telemetry and preserve development dependencies/volumes:

```text
docker --config .cache/docker compose -f infra/compose/compose.yaml --profile telemetry stop telemetry-relay collector prometheus alertmanager
```

## Measurement boundaries and targets

These are proposed initial objectives, **not achieved SLOs**. The local fault harness is a correctness/recovery drill with artificial outages, not a load test or a monthly availability report. Production measurement needs authenticated eligible request classification, fleet aggregation and a durable external time series store.

| Signal/target | Exact boundary and limitation |
| --- | --- |
| Acceptance p50/p95/p99 | Histogram from API request admission through completed response; `POST /api/v1/messages`, status 200. Initial targets p95 ≤300ms, p99 ≤1s for bounded accepted commands. Includes retries returning an existing result and attachment references after approval; no attachment upload/scan, browser networking or displayed delivery. Use `histogram_quantile(0.50/0.95/0.99, sum by(le)(rate(chat_http_request_duration_seconds_bucket{role="api",method="POST",route="/api/v1/messages",status="200"}[5m])))`. |
| Acceptance availability target ≥99.9% over 30 days | Eligible authenticated writes reaching the server; exclude client validation/auth/rate-limit responses. Current recording rule is a 5m proxy: 5xx / (200 + 5xx); it omits requests that never reach the process and cannot establish fleet availability. Local alert threshold 1% for 5m is an operational alarm, not the 30-day error budget. |
| Projection p95 ≤3s | Canonical event creation to **completed** fenced Redis publication. Retries contribute only when publication completes; stalled work is covered by backlog age alerts. It is not browser receipt/application latency. |
| Backlog/provider alarms | Oldest durable intent >30s for 15s, terminal jobs/DLQ >0 for 10s, protocol failure for 10s; tune from measured workload. A fresh failed probe means that capability is unavailable, not that the whole process should restart. |
| Lost monitoring | Snapshot older than 30s for 10s; target scrape down for 15s; individual probe timestamp older than 65s for 15s. Missing/disabled providers are not reported healthy. |

Counters track terminal message duplicate/conflict outcomes, replay cursor expiry, worker/call reconciliation failures and audited DLQ replay. AMQP diagnostic ready/unacknowledged/consumer counts are separate from durable Mongo intents; missing Rabbit management age stays unobserved. Approved attachment bytes/count are retained ready metadata, not a bucket bill; open calls/accepted participants are durable access state, not proof of connected media. SFU metrics aggregate a finite name list and discard room/participant/provider labels; absent bandwidth/packet-loss/RTT/TURN metrics remain unobserved. Completed room duration and quality histogram sums/counts, when present, remain provider measurements. Do not infer bandwidth cost, client jitter, TURN usage or end-user quality from unavailable names. Existing worker outbox/retry/dead-letter/projection metrics remain separate.

## Dependency failure policy

| Dependency | Allowed/rejected behavior | Recovery and visible state |
| --- | --- | --- |
| MongoDB | API liveness stays up; readiness and durable commands fail closed. Gateway/worker cannot authorize or commit effects. | Restore writable primary; retry the same command ID and reconcile. Never replace durable state with Redis. Single local primary is not HA. |
| Redis | Durable history can be read with Mongo authority; writes needing shared rate guards and live gateway admission fail closed. | Reconnect guards/adapter/fanout; replay repairs hints and convergence. Gateway/worker readiness reflects Redis; API readiness remains Mongo-only and does not promise every operation works. |
| RabbitMQ | Valid writes may commit to outbox within admission limits; publication/projections are delayed. API liveness/readiness remain independent. | Worker retries with backoff; expired leases are fenced, broker confirms precede completion. Worker readiness fails. Retained pending work is not discarded. |
| Object storage | Text remains usable; file creation/upload/scan/download operations may fail or retry. Never serve unapproved bytes. | Retry the bounded stage; inspect inventory/object agreement, preserve quarantine and immutable approved versions. |
| Scanner / image processor | Text and unrelated calls continue; affected attachments stay unapproved, pending/retrying or terminally failed. No bypass. | Restore protocol/decoder service, retry preserved jobs through documented attachment policy. |
| LiveKit / media | Text remains usable; new calls/credentials fail when provider health/admission cannot be proven. Existing sessions follow SDK reconnect behavior. | Reconcile durable call/incarnation state; explicit user rejoin may be necessary. No transparent room migration claim. |
| SMTP | Sessions/text continue; verification/recovery mail remains encrypted queued work with bounded retry/dead state. | Inspect redacted job classification and retry safely. Probe tests do not send mail. Existing email retry tests cover actual local delivery separately. |
| Push | In-app inbox and permitted fallback remain; disabled provider stays disabled. Failed sends follow bounded retry/subscription cleanup. | Provider result remains unobserved until a consented real native/browser delivery gate runs; do not turn key presence into health. |
| Browser local storage | Authorized server state remains authoritative; IndexedDB failure limits durable local pending/replay/draft behavior. | Show the existing local-state warning/recovery flow, reconcile by stable command IDs and replay/snapshot. Server telemetry cannot certify browser persistence. |

Protocol reachability and app readiness have different purposes. The real fault test checks the implemented scopes; attachment scanner behavior, browser IndexedDB failures, native push and relayed media have their separate evidence/gates. Alert recovery is not data-recovery certification.

## Draining and maintenance

`DRAIN_DELAY_MS` defaults to 1000 (0-10000); `DRAIN_TIMEOUT_MS` defaults to 10000 (1-60000). An orchestrator should remove an instance from routing as soon as readiness fails, wait the propagation delay and allow the configured work deadline plus 2.5 seconds for bounded telemetry shutdown. Deployments must budget sufficient termination grace; a missed deadline exits unsuccessfully and requires normal retry/lease recovery.

Send SIGTERM or SIGINT to an individual built application process. API/gateway immediately close admission and readiness, leave liveness available during the propagation delay, and then close transports/pools. Accepted HTTP handlers and prehandlers remain tracked separately from the connection. Draining HTTP/1 responses set `Connection: close` after the response; handlers are not forcibly cut off to clear keep-alive. New API work receives retryable 503/`Retry-After: 1`; use the same idempotency key on retry. A disconnected client may have an ambiguous outcome and must reconcile before resending with a new key. Health/metrics remain available until transport close.

Gateway rejects new handshakes/commands, stops new hint/periodic intake, waits for owned work **including work whose socket has disconnected**, then emits `sync:reconnect`, closes sockets and releases connection/presence leases before Redis/Mongo pools. Queue hints may be discarded during shutdown; durable Mongo replay and inbox discovery repair them. Reconnection is not delivery acknowledgement.

Worker immediately cancels broker intake and prevents new top-level claims, completes accepted effect commits/confirmed handoffs and currently running bounded job methods, then closes dependencies. A job method may include several bounded internal stages. Abrupt deadline/process loss can leave owned claims; another worker reclaims only after the existing server-time lease and fences stale owners. An unconfirmed broker delivery stays unacknowledged. Do not delete claims or dedup records to make a shutdown look clean. Concurrent `close()` calls on API/gateway await the same shutdown operation.

Before media maintenance, set `MEDIA_DRAINING=true` on **every API and worker instance** via a controlled drain/restart. This disables fresh call starts and credential issuance while call history, end/leave/remove, signed webhooks and worker cleanup continue. Leave `CALLS_ENABLED=true` on the worker while ending/cleaning existing rooms. Workers retain queued pending incarnations without creating provider rooms while this flag is set, and continue cleanup/reconciliation of existing rooms. In-flight provider operations accepted before drain may finish; wait for them to settle after the flag rollout. The flag does not migrate an active SFU room, revoke previously issued tokens, or empty existing rooms. Wait for calls to end and all incarnations to be deleted before stopping the SFU. Use `CALLS_ENABLED=false` on workers only when explicitly ending remaining calls is intended. Cross-node flag rollout, killed-SFU recovery and live-media rejoin are not certified by the backend flag test.

Windows tests invoke the actual registered signal handler through a test-only IPC bootstrap because Windows does not provide POSIX SIGTERM delivery. Linux tests send SIGTERM. The bootstrap is not shipped in application entrypoints. Local successful exit is not a Kubernetes/VM deployment certification.

## Production topology and authority design (not provisioned)

Initial target: one region with at least two API and gateway instances behind a TLS edge, independent worker capacity, a multi-zone Mongo replica set with majority journals, redundant durable quorum broker nodes, protected Redis appropriate to its adapter/ephemeral role, private versioned object storage, isolated scanner/image workers, and separately sized SFU/TURN nodes. Private collector/metrics/alerting and an audited operations plane run outside public application routing. A full region outage remains unavailable until a separately designed regional recovery procedure completes. Redundancy cannot be claimed from the single-node local Compose profile.

Keep Mongo/broker/Redis/storage/provider/telemetry/admin interfaces private; expose only the web edge and explicitly designed media transport. Restrict health/metrics at the edge while retaining private orchestrator probes. Mongo workload roles should grant the application only required collection reads/writes/transactions and the operations/migration role DDL; no application drop/admin rights. Broker roles scope application publishes/consumes to its namespace and deny topology replay/admin to public-facing identities where provisioning permits. Storage capabilities separate quarantine upload/read/scan/promote from approved read/delete, with short-lived presigned requests and no bucket listing from browsers. Media admin signing credentials belong only to trusted API/reconciliation roles. Scanner/image workers receive only the objects and capabilities needed for their stage. Verify exact provider ACL behavior and rotation before deployment; local shared development credentials prove none of this least privilege.

Recovery and upgrade tooling remains unimplemented at this checkpoint. Do not run a database dump into development as a restore drill. The ordered next gates require a fresh isolated target, encryption/integrity/object checks, current deletion/revocation reapplication, stale credential/job suppression, index/authorization/reconciliation validation, and a real prior/current process overlap. A db-scoped dump alone does not establish live PITR or a regional RPO/RTO. Retain command/effect/deletion/incarnation ledgers until the measured supported retry/upgrade/restore windows and safe compaction policy exist.

Operational references used while implementing: [OpenTelemetry Node SDK](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/), [Fastify admission/readiness](https://fastify.dev/docs/latest/Guides/Delay-Accepting-Requests/), [MongoDB dump consistency boundaries](https://www.mongodb.com/docs/database-tools/mongodump/mongodump-behavior/). These are design references, not test evidence.

08B tooling references: [Prometheus alert rules](https://prometheus.io/docs/prometheus/latest/configuration/alerting_rules/), [Alertmanager configuration](https://prometheus.io/docs/alerting/latest/configuration/), [Collector configuration](https://opentelemetry.io/docs/collector/configuration/), [pinned transform processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.163.0/processor/transformprocessor/README.md), [pinned file exporter retention](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/v0.163.0/exporter/fileexporter/README.md), [Docker local tmpfs volume options](https://docs.docker.com/reference/cli/docker/volume/create/). The release patch image is 0.163.1; component documentation/source uses the available v0.163.0 tag. Configuration validators and actual ingestion were both run.
