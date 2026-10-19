# Phase 08 evidence - 2026-10-18

Status: **in progress, not fully verified**. User explicitly requested the next phase after commit `f4396e3`; Phase 06 native positive push/provider delivery and Phase 07 forced TURN/Linux browser routing are carried as unverified. No commit/deployment/public listener/external provider message was requested or performed.

Latest checkpoint: **08A and 08B locally verified in their stated scope; resume at 08C**. Historical 08A remaining-task lists below are superseded by the 08B checkpoint at the end. Encrypted restore, actual overlapping binaries and interrupted lease/media drills remain unimplemented/unverified.

## Implemented checkpoint: 08A

Opt-in manual OpenTelemetry SDK 0.223.0 / trace core 2.12.0 with bounded HTTP export, fixed W3C propagation, deterministic sampling, no automatic instrumentation/resource detection/SDK diagnostics/log export. Active IDs in existing redacted logs. API method/template/status histograms, drain/in-flight/rejection metrics, Mongo driver pool lifecycle counters/gauges. Additive `008_operations` expands only the outbox validator with optional validated traceparent. New writers omit that field before 008; old rows and unchanged strict v1 JSON writers remain valid. Relay/consumer AMQP headers retain safe context through retry/DLQ; fanout/gateway recover context from the canonical outbox reference without changing Redis payloads.

API closes admission/readiness, tracks prehandlers and handler completion independently of sockets, and completes accepted replies before closing dependencies. Gateway tracks owned work independently of socket membership, stops periodic/hint intake, waits before reconnect/disconnect and lease/pool release. Worker cancels broker intake promptly, prevents new top-level claims, completes owned methods and leaves interrupted claims fenced for recovery. Media maintenance rejects fresh starts/credentials and pauses queued worker room creation while permitting end/cleanup; existing rooms are not migrated. See [operations runbook](runbooks/operations.md) for configuration and the proposed (unprovisioned) production topology/authority boundaries.

## Verification record

`pnpm exec vitest run --config tests/integration/operations.config.ts --reporter verbose`: **10 passed**, 137.10 seconds with other local regressions running. This includes the real aborted-client branch and all three compiled entrypoints. Exact supporting regression results and cleanup follow below once those active checks finish. This verifies the scoped 08A controls, not the entire Phase 08 gate.

Executed targeted passes before final regression:

- Real HTTP -> Mongo outbox -> RabbitMQ header/confirmed publication -> consumer effect -> Redis fanout -> gateway dispatch exports a connected trace to a bounded loopback OTLP JSON receiver. Browser trace headers do not select the root trace. Exported bytes exclude sentinel message/query/baggage, session/CSRF tokens and conversation IDs. Metrics exclude query strings and use the route template.
- Actual strict old-schema write, additive DDL reruns, new trace metadata, old-format row acceptance and invalid-parent validator rejection. This is a current-process schema/wire compatibility check, **not** a prior/current binary upgrade drill.
- Actual broker retry and DLQ handoffs preserve validated trace context and exclude raw error text. Consumer intake cancellation waits for an accepted real Mongo effect while queued work remains undelivered.
- Gateway refuses later commands/readiness and waits for accepted work even after socket disconnection. Exporter 503/final recovery leaves acknowledged writes intact; local log sink verifies IDs/redaction. Real LiveKit maintenance admission/end/provider cleanup succeeds.
- Real HTTP accepted-write drain now passes. Each compiled API/gateway/worker entrypoint passes readiness -> signal handler -> 503 readiness with live health -> exit 0, preserving a worker-confirmed outbox publication and one idempotent message. Windows uses explicitly labeled test-only IPC to invoke the actual handler; Linux path sends SIGTERM and has not been executed on this host.

## Failures and corrections

1. Dependency install initially stopped at pnpm's denied `protobufjs` postinstall. Inspected script only emits a dependency-version warning; explicitly denied it rather than enabling arbitrary scripts. Exact pins/lockfile preserved. Sandbox denied the later pnpm store lock; scoped automatic escalation completed the cached dependency link. No automatic-approval rejection occurred.
2. Initial builds caught exact-optional-property and collection-info union issues. Corrected before runtime tests. Tools typecheck caught message reference/id and Mongo string-ID typing in new tests; corrected.
3. Initial 8-test operations run: 7 passed, HTTP drain failed because injection did not model transport ownership. Added independent handler/prehandler tracking and a real HTTP test. The real test then found a 72-second keep-alive delay for an accepted response finishing after shutdown began. Draining HTTP/1 responses now set `Connection: close`; the test passes without forcibly ending accepted handlers or enlarging its timeout.
4. Initial child-process bootstrap using a tsx-loaded TypeScript wrapper did not reach readiness within its limit. Switched the **test-only wrapper** to native JavaScript around the built entrypoints, matching actual process runtime; all three then passed. No production test control endpoint or signal IPC seam was introduced.
5. Interrupted early diagnostic test runs are not counted as passing suites. Final results below supersede individual earlier passes. Vite's existing ~506/540 KiB chunk warnings remain visible; no frontend bundle-size fix is claimed.

## Outstanding required Phase 08 gates

- 08B: optional pinned private collector/Prometheus/alert profile, finite diagnostics and dependency probes/replication/queue/DLQ/worker/provider/QoS/cost metrics; meaningful latency/delivery objectives, actual dependency fault-to-alert/recovery checks and `test:failure:dependencies`. Current telemetry receiver is a fixture; no operational alert pipeline is implemented.
- The trace-chain test runs application components in one test process against real HTTP/Mongo/Rabbit/Redis transports; the separate compiled-process drain test disables tracing. Positive export/correlation across all separately running role entrypoints and the operational collector remains an 08B check. Do not turn the in-process receiver fixture into a claim of fleet telemetry or production collection.
- 08C: encrypted bounded quiescent backup/object inventory/deletion ledger and fresh-target restore, full authorization/index/BSON/object/reconciliation checks, deletion reapplication and stale credentials/jobs suppression. Implement/run `test:restore`, including tamper/wrong-key/missing-object/unsafe-target negatives. No backup, restore, live PITR, RPO/RTO or backup erasure is verified.
- 08D: actual prior/current release overlap, protocol/DDL rerun compatibility and process/lease/media loss recovery; implement/run `test:upgrade`. Current optional-field test does not prove a binary overlap or Linux/orchestrator shutdown.
- 08E: complete required checks, operational evidence/runbooks and exact resume updates. Production IAM/TLS/private routing, log/backup retention, HA, capacity and region recovery remain unprovisioned. Phase 09 polish/a11y/avatar privacy/full browser feature audit/clean setup/demo/measured capacity/deployment remains separate.


Final review refinement: all 18 ordinary browser checks passed before changing the media worker. Review found the maintenance flag also needed to cover provider room creation already queued before admission closed. The worker now holds pending rooms while MEDIA_DRAINING is true; the expanded real-provider test checks absence of a room, resumed creation with the normal worker, and deletion with the paused worker. Affected final verification follows below; the earlier media test did not cover queued allocation.


## Final scoped verification and preserved environment

08A is **locally verified in the scope below**. Full Phase 08 is not verified. Final operations rerun after the queued-media allocation fix: 10 passed in 86.10 seconds; affected calls integration rerun: 12 passed in 67.77 seconds; actual generated-media browser calls rerun: 3 passed. Earlier repeated passes are not added to the distinct-test count.

| Executed suite | Passed |
| --- | ---: |
| Unit (including new telemetry/config negatives) | 40 |
| Real HTTP foundation | 3 |
| Foundation integration | 6 |
| Auth integration | 14 |
| Conversations integration | 16 |
| Messaging integration | 8 |
| Sync integration | 13 |
| Attachments integration | 14 |
| Safety integration | 19 |
| Calls integration | 12 |
| Gateway failure | 7 |
| Outbox failure (including actual Rabbit stop/restart) | 12 |
| Operations integration | 10 |
| **Backend/unit/HTTP total** | **174** |
| Browser auth / conversations / messaging / sync | 2 / 1 / 1 / 6 |
| Browser attachments / safety / calls | 1 / 4 / 3 |
| **Browser total** | **18** |
| **Distinct passing scoped checks** | **192** |

Full build, workspace/tools typecheck, lint/import boundaries, frozen offline install with normal reviewed build policy, Compose syntax, production dependency audits (workspace and isolated processor), server-secret-name browser bundle scan and Git whitespace check passed. Final changed media worker was rebuilt and its tools typecheck/lint and affected integration/browser checks rerun. No remote CI result exists. The added CI operations gate depends on existing real local media startup.

Browser checks used a separately created, identity-verified disposable Mailpit receiver on 1026/8026. The outbox fault test now respects MAILPIT_URL, so its real synthetic email proof can also use that receiver. RabbitMQ outage ran only after browser/other app processes finished; all 12 outbox cases passed in 105.01 seconds and Rabbit recovered healthy. The initial auth integration real-email case used the default local receiver; existing messages were retained. Browser/outage synthetic mail used the disposable receiver. No external email was sent. Vite websocket-close and client SDK removal/rejoin diagnostic warnings appeared during passing scenarios; no suppression or client SDK diagnostics/privacy certification is claimed. Manual server telemetry privacy assertions cover the exported/structured fields described above.

Final cleanup: disposable mail receiver removed; original eight dependency containers healthy and original volumes retained; authenticated LiveKit API healthy. No listeners remain on task app/test ports 3000/3001/3002/5173/39002 or disposable mail ports 1026/8026. Two interrupted operations fixtures were explicitly validated (names, synthetic account domains, no attachment inventory, owned media prefixes) before removing only their databases/broker topology/provider rooms. Final inspection reports zero operations/browser fixture databases, two ordinary development accounts and eight migration markers. Migration 008 was applied/rerun with ordinary account documents byte-identical before/after; original brief and applied 001-007 migration source files have no Git differences. Preserve applied 008 too.

All Phase 08 changes remain uncommitted, based on f4396e3. No deployment, public listener, paid service or external provider message. Resume at **08B** in the latest implementation_plan.md checkpoint; do not repeat/relabel 08A as the whole phase. Restore/upgrade/alert/native-provider/network/production gates listed above remain unimplemented or unverified as stated.

## Phase 08B checkpoint - 2026-10-18

**Locally verified scoped telemetry/fault implementation; full Phase 08 remains in progress.** Preserved the existing 08A work and applied migrations. Added no further migration. The original seven migration sources and implementation brief have no Git differences; preserve applied 008 too (SHA256 `19F89390A30B85DE42E25BAFD2FD05452FF43B445B2FA382DC6A1953EFE909FB`). All changes remain uncommitted.

Implemented an opt-in pinned Prometheus 3.15.0 / Alertmanager 0.34.1 / contrib collector 0.163.1 profile, exact image digests, bounded resources/retention and loopback host ports. A bounded host agent uses real read-only dependency protocols and atomically hands finite snapshots to an internal readonly relay. No app bind was broadened or host-gateway scraper introduced. Freshness, missing observations and provider-disabled states are explicit. The collector filters approved services/spans, rejects linked spans, drops events/private attributes/status text/tracestate and writes rotated files into a bounded shared tmpfs store with a private readonly reader. Alertmanager's only receiver is the bounded internal sink; there is no external integration. See [operations](runbooks/operations.md) for exact budgets, retention limitations, targets and the dependency matrix.

Added finite dependency/replication/pool/queue-age/DLQ/failure/inventory/media metrics, successful projection-publication lag, terminal message duplicate/conflict and expired-replay counters. SFU aggregates remove all identity labels; unavailable provider metrics remain unobserved. Audited operator DLQ replay preserves only validated W3C context even with its SDK disabled. An explicit owned channel release now preserves the broker publisher; unexpected channel closure still fails transport readiness/publication. Successful local SMTP probes send only greeting/EHLO/QUIT. Synthetic retry mail is stopped before unblocking its receiver; actual local email delivery remains separately exercised by the outbox regression.

### Executed acceptance

`SMTP_PORT=1026`, `MAILPIT_URL=http://127.0.0.1:8026`, `pnpm test:failure:dependencies --reporter=verbose --bail=1`: **12 passed in 229.29s**, Node 24.21.0 / pnpm 12.11.2, Windows and Docker Desktop Linux containers. This is a correctness/recovery test, not capacity/SLO attainment. The final stronger positive worker histogram assertion was separately rerun with the actual three-process trace case: **1 passed**, 11 deliberately unselected; not added to the distinct count.

1. Actual pinned promtool configuration/rules validation, three promtool rule scenarios, amtool and collector validation; effective Docker loopback mappings and actual Prometheus retention flags.
2. Actual Mongo/Redis/AMQP/S3/scanner/processor/LiveKit/SMTP protocol health, finite inventory, unavailable secondary lag, disabled/unknown push, aggregate media metrics and private-value negatives.
3. Oversized/stalled/redirected inspection bounds, local-only target/path guards, SFU label removal; shared capture non-overlap, repeated-failure backoff and real recovery.
4. Silent TCP peers accepting Redis/AMQP connections but never answering still finish inspection within the asserted deadline; Redis has an overall handshake deadline in addition to its TCP connect/command timeout.
5. Actual duplicate/conflict and cursor-expiry outcomes; actual audited DLQ replay, valid/invalid parent headers, no baggage, repeated replay on a shared transport, intentional release versus unexpected channel failure.
6. Separate compiled API/gateway/worker processes with their SDKs enabled → accepted real message → Mongo outbox → Rabbit confirmed publish/consume → Redis projection → gateway → actual collector file. All three service resources, required span names, trace IDs, HTTP/outbox parent relationship, actual positive worker histogram and privacy negatives passed. A concurrent agent using the same directory is rejected by its exclusive lock.
7. Actual collector ingestion removes unexpected resource/span attributes, status text/events, unapproved services/names and linked spans; only the valid sanitized span remains.
8. Real Mongo/Redis/Rabbit fault proxies → fresh failed probes → evaluated Prometheus rules → Alertmanager → internal firing **and resolved** notifications. Liveness remains usable; Mongo/Redis writes fail closed without a committed message; Rabbit outage still accepts a bounded durable outbox intent, reports worker unready and publishes after recovery.
9. Real storage/scanner/processor/LiveKit/SMTP faults and recovery alerts while text/API readiness continue; call start rejects while media is unavailable; SMTP work retains encrypted pending retry state during outage.
10. Stop the real host agent, wait for snapshot expiry/hold time, observe stale alerts and absence of cached Mongo success, restart and observe resolved notifications. The artifact records firing/resolved alerts for every one of the eight inspected dependencies and all four role snapshots.

The passing complete run's ignored artifacts are `.cache/telemetry-drill-267c960de5f5/{alerts.json,traces.json,snapshots/*,collector.log}`. The internal sink recorded 20 firing and 20 resolved notifications (including readiness/worker/fixture-cleanup signals); these are local harness observations, not external alert delivery. The strict focused trace rerun uses `.cache/telemetry-drill-e8fbc83567cf`. Do not rely on these ignored artifacts existing in a fresh clone.

### Corrected failed attempts

Initial Docker internal-only networking omitted effective host mappings despite Compose's intended port declaration; readiness failed and assertions were skipped. Only the three host-facing telemetry services now also join a dedicated bridge with explicit loopback publishes; relay/sink remain internal. This is not a production egress-deny implementation.

The first real suite exposed Prometheus's readonly `/tmp`, an undersized Redis handshake queue, intentional replay channel closure poisoning a shared broker, Windows atomic-replacement sharing errors, and a double-slash processor probe URL. These were fixed with bounded tmpfs, a finite handshake queue, explicit owned channel release, bounded sharing-error retries and URL construction. Typecheck also caught a nullable diagnostic stream; fixed and all workspace/tools checks rerun.

Collector syntax validation accepted a link-clearing expression whose type failed at runtime. Linked spans are now explicitly filtered and positive/negative ingestion is tested. Docker `cp` did not expose live tmpfs contents even while the collector reported a successful export; actual file inspection now uses the readonly shared tmpfs reader. Cross-process exporter batches can arrive in different order; the assertion waits for every required service/span rather than assuming gateway arrival is last.

Five simultaneous test inspection processes exceeded the relay's unchanged 32-PID limit. Test readers now coalesce concurrent alert reads; application limits were not raised. A subsequent optional recovery attempt correctly reported SMTP unavailable: the long-lived development Mailpit container has no command override and lacks the current Compose `--smtp-disable-rdns` option. It was left intact to preserve existing mail. Final SMTP/browser/outbox checks used a labeled disposable receiver with that option. Recovery waits account for the documented 30s backoff plus capture/scrape delay. Earlier failed/skipped attempts are not counted as passing suites.

### Regressions and cleanup

| Executed scope this checkpoint | Passed |
| --- | ---: |
| Unit | 40 |
| Messaging / sync integration | 8 / 13 |
| Gateway failure / calls integration | 7 / 12 |
| Operations / safety / attachments integration | 10 / 19 / 14 |
| Outbox failure, including real Rabbit stop/restart | 12 |
| New telemetry/dependency suite | 12 |
| **Backend/unit total** | **147** |
| Chromium messaging / sync / calls | 1 / 6 / 3 |
| **Browser total** | **10** |

**157 distinct scoped passes** this checkpoint; repeat/focused passes are not added. Earlier 08A auth/conversation/foundation checks remain historical evidence, not newly rerun suites here. Browser calls exchanged generated devices through real local LiveKit; forced TURN/native push remain open. Vite socket-close and client SDK room-removal warnings occurred during passing browser scenarios; no browser diagnostic privacy certification is inferred.

Workspace build, full workspace/tools typecheck, lint/import boundaries, all-profile Compose validation, normal-policy frozen offline install, production workspace/processor audits (no known vulnerabilities returned), server-only configuration-name browser bundle scan passed. The first sandboxed install could not open pnpm's normal per-user operation lock; its authorized scoped retry passed. `pnpm infra:telemetry` and the actual agent entrypoint were smoke-tested; SIGINT handler stopped the agent cleanly and removed its lock. The agent produced actual optional SFU metrics. CI includes pinned tool preparation and the dependency suite; no remote CI result is claimed.

Rabbit stop/restart ran after browser/distributed app shutdown: **12 passed in 70.92s**, Rabbit healthy again. All test telemetry projects/volumes removed; default telemetry smoke containers, proven-unused tmpfs/networks, labeled disposable mail receiver and two proven-empty disposable browser buckets removed. Original eight dependency containers remain healthy, authenticated LiveKit has zero rooms, no task application/mail/telemetry listeners remain. Development has two ordinary accounts and eight migration markers; current private fingerprints saved in `.cache/phase08b-preservation.json` for the next checkpoint. No source/development database was restored/dropped, no original bucket/volume/mail store reset, no commit or deployment.

Resume **08C encrypted quiescent backup/restore**, then 08D actual prior/current binaries and interrupted lease/media recovery, then 08E final phase validation. Neither `test:restore` nor `test:upgrade` exists yet; do not report Phase 08 complete. The exact remaining ordered tasks are in the latest implementation plan checkpoint.
