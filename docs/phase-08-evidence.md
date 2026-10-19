# Phase 08 evidence - 2026-10-18

Status: **in progress, not fully verified**. User explicitly requested the next phase after commit `f4396e3`; Phase 06 native positive push/provider delivery and Phase 07 forced TURN/Linux browser routing are carried as unverified. No commit/deployment/public listener/external provider message was requested or performed.

Latest checkpoint: **08D locally verified within the actual release-overlap/interrupted-work/media scope at the end**. Historical remaining-task lists are superseded by the latest checkpoint. Full Phase 08 remains in progress; 08E consolidated final gates are separate.

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

## Phase 08C - local encrypted recovery (2026-10-19)

Entry state was clean at **907e35c**, with 08A/08B committed. Before changes, both ordinary user records and the eight schema markers matched the private 08B fingerprints. All applied 001–008 migration bodies and the original brief remain unchanged; 008 SHA256 remains `19F89390A30B85DE42E25BAFD2FD05452FF43B445B2FA382DC6A1953EFE909FB`. No migration was added. Current 08C work is uncommitted.

Implemented `pnpm ops:recovery backup|policy|restore` with actual Compose mongodump/mongorestore, streaming authenticated encrypted frames and approved-object inventories/checksums. A capture must be source-write-free; a retained, bounded replica oplog interval checks transaction/DDL writes and aborts a changed capture. A separate later policy binds the snapshot ID, namespace and replica authority; restore requires it within one hour and refuses stale/foreign/missing policies. This requires a trusted latest policy with source writers stopped; the age check alone does not prove no subsequent deletions or establish a continuous independent policy ledger. See the [recovery runbook](runbooks/recovery.md) for that operational condition, exact format/limits, key custody, retention, RPO/RTO and failure-domain limits.

Restore authenticates a complete first pass before claiming a fresh `restore_<uuid>` namespace, then authenticates each replayed frame. It compares actual restored validator/index/count metadata, withholds schema markers, applies current privacy/authorization/deletion policy, reads back verified new-prefix objects, invalidates old passwords/sessions/tokens/push registrations, suppresses old external jobs, resets claims and closes historical calls. Current policy sequence high-watermarks prevent reuse of positions known to that boundary; canonical deletion events and replay floors force authorized repair. Current blocks/roles and intersected visibility are retained. Pending outbox identities still require actual confirmed publication. No source room or object key is reused for new serving state. The current API/gateway/auth/worker and migration runner honor an incomplete restore fence; Mongo health/liveness stay separate. A worker rechecks its stop flag after awaiting that fence, preserving drain admission semantics.

### Executed recovery gate

`pnpm test:restore --reporter=verbose --bail=1`: **15 passed, 176.59s**, both real recovery integration and format tests. A final focused restored-target migration-rerun check passed (1 selected, 14 unselected, 56.19s), and the final CLI target-allocation/reporting path passed separately (1 selected, 14 unselected, 94.99s). Repeats are not added to the distinct count. Tests exercised:

- Actual encrypted Mongo archive plus scanned, approved private object bytes; no private sentinels/credentials in artifact bytes. Frame chunk bounds, finite entries/metadata, exclusive output creation, key/path guards, wrong key, ciphertext/header edits, reordering/replay, truncation and appended bytes.
- An actual source transaction after dump/object copying aborts the capture and removes only its incomplete encrypted output. Existing artifact files are never overwritten. Missing physical source approved bytes also abort and leave no complete artifact.
- Wrong-key/tampered restore inputs do not create a target. Source/development/system names and an occupied disposable target are rejected; its sentinel remains intact.
- Actual namespace-mapped mongorestore with validators, ordered index metadata, unique indexes, rerun migration markers and BSON Long message positions above 2^53. While restored user/session data exists but verification is incomplete, auth and HTTP readiness return 503, liveness remains 200, Mongo dependency health reports up, migrations reject, old-style outbox claims return null with absent markers, and an actual separate compiled worker stays unready without taking the old claim.
- Old password/session rejection, fresh reset-link consumption and login, current message/account deletion scrubbing, retained authorized peer history/file bytes, removed/outsider denial, current block/role reapplication, sequence counter advancement and expired-cursor snapshot repair. Old email/token/session work is cleared before fresh recovery actions. A real source LiveKit room was allocated; the restored call is ended, cannot issue a join and has no reused source room record.
- Same snapshot command IDs return their original accepted references after restore, with one message result. Retained outbox work confirms publication through actual Rabbit, notification suppression effects reject old external expansion, and fanout reconciles through actual Redis.
- A correctly authenticated but incomplete object inventory cannot become ready: its target stays fenced with no schema markers. Separate stale/foreign policy bundles fail before target creation.
- Actual CLI backup → policy → restore in subprocesses with a runtime-only key. Output contains run/target IDs without the key. Docker child environments do not inherit `RECOVERY_KEY`.

Primary complete-run artifacts are ignored under `.cache/recovery-drill-372d274f-f86a-49e6-9e08-35f4938cfee9/`: encrypted `.crb` files and nonsecret `timings.json`. Test keys are generated in memory and not retained; rerun fixtures rather than treating old test bundles as recoverable operational backups. This is a small local namespace drill on existing services, not restoration to an independent host/region or production key-custody proof.

Measured host: Windows, Node 24.21.0 / pnpm 12.11.2, i5-13450HX, 16 logical CPUs, 15.78GiB RAM, Docker Desktop Linux containers on the same machine; other local tests ran concurrently. Fixture: five users, one group, three messages (including sequence >2^53), two scanned approved text objects (66 bytes total) and an actual source call. Encrypted main snapshot was 51,895 bytes and policy 15,651 bytes. Measured capture **2651.46ms**, policy capture **1724.89ms**, restore with additional API/worker fence assertions **14304.06ms**, and separate CLI restore **12697.13ms** including process startup. The whole CLI backup/policy/restore test took 47.73s. These are observed small-fixture timings, not latency/capacity benchmarks or a production RTO. They exclude human key recovery, routing, user password recovery, independent-host provisioning and verification.

Data RPO is the completed quiescent snapshot; acknowledged writes after it may be lost. The current policy sanitizes privacy/authority and reserves known sequence positions, not missing post-snapshot message payloads or every later dedup ledger. There is no zero backup RPO, live PITR, regional availability or cryptographic-erasure claim. Older encrypted bundles may retain later-deleted data until their retention/key lifecycle ends. Source provider credentials and cached bearer URLs retain their original validity wherever the source infrastructure remains available; the restored namespace does not reuse them.

### Corrections during verification

Initial fixtures used the wrong accepted-message shape and omitted a required mutation version, so setup failed and tests were skipped. A tamper test initially edited a frame length rather than ciphertext; both were safely rejected, and the intended ciphertext case was corrected. A missing-source-object fixture initially violated the existing unique source-key index; it was corrected to use a distinct owned key. These failed/skipped attempts are not counted as passes.

The real restored-password negative exposed an application bug: Argon2 was called with the deliberately empty invalidated hash. Empty hashes now use the initialized dummy-verification path and still return false, producing normal 401 rejection instead of an exception. Typecheck/lint caught unused imports and a metadata union type; fixed and checked again. Verification also drove current conversation/inbox watermarks, current blocks/roles, migration-rerun coverage, bounded streaming policy capture, guarded fixture cleanup and the post-await worker stop check. Applied migrations were preserved.

Auth integration now honors `MAILPIT_URL`, allowing its actual delivery case to use the same disposable receiver as browser/outbox tests. Existing development mail is retained. Final regression/cleanup totals are recorded below; the separate 08D/08E requirements remain open.

### Final 08C regression notes

The first dependency regression run finished with 11 passes and one all-dependencies-up timeout while backend/browser/service-heavy checks overlapped. The unchanged suite was then run without those workloads: **12 passed, 306.50s**, including the previously failing check (910ms), actual core/optional faults, real trace export and stale-agent recovery. This supports local sequential regression success; it does not establish load tolerance or a diagnosis of the earlier timeout. Probe deadlines and service limits were not increased. The earlier failure remains recorded here.

Final workspace build, workspace/tools typecheck and lint/import boundaries passed. Build retains the existing >500kB chunk warning. A browser-dist scan found no server-secret setting names, including `RECOVERY_KEY`. Frozen offline installation under normal package policy passed; workspace production audit and processor production audit reported zero known vulnerabilities. All-profile Compose configuration validation passed. Original brief and all eight applied migration source files have no Git differences; applied 008 SHA256 remains `19F89390A30B85DE42E25BAFD2FD05452FF43B445B2FA382DC6A1953EFE909FB`. The migration registry changed only to honor the restore fence.

A separate actual CLI missing-input refusal check exercised default random target allocation: exit 1 reports the generated candidate target without the runtime key. This manual check and focused recovery reruns are not added to distinct test totals. The actual CLI success case remains part of the 15-check recovery suite. Remote Linux CI has not been run from this session.

Final outbox failure run, after all other application/telemetry verification processes stopped: **12 passed, 124.92s**, including actual process exit after publication and real Rabbit stop/start with durable acceptance/recovery. Final distinct totals are **201 backend/unit/HTTP + 18 browser = 219 passes**: 40 unit, 3 HTTP, 6 foundation, 14 auth, 16 conversations, 8 messaging, 13 sync, 14 attachments, 19 safety, 12 calls, 7 gateway failure, 12 outbox failure, 10 operations, 12 dependency failure, 15 recovery; browser 2 auth, 1 conversations, 1 messaging, 6 sync, 1 attachments, 4 safety, 3 calls. This is local executed regression scope, not completion of unexecuted native push/TURN/upgrade gates.

Final read-only preservation check: two ordinary development users and eight migration markers have exactly the prior 08B fingerprints; saved privately to `.cache/phase08c-preservation.json`. Zero owned recovery/operations/dependency/browser/outbox fixture databases and zero LiveKit rooms remain. Original eight dependency containers are healthy, authenticated LiveKit is available, original volumes/buckets/mail are retained. The label-checked disposable mail receiver was removed; telemetry projects/volumes cleaned themselves. Checked ports 3000/3001/3002/5173/1026/8026/4318/9090/9093/39002 have no remaining task listener. Ignored encrypted drill files/timings remain without retained test keys. No commit/deployment was performed. Resume at **08D** in the latest implementation-plan checkpoint; 08C is locally verified, while full 08 and later gates remain open.

### CI correction: nullable Docker port bindings (2026-10-19)

The supplied Linux CI log failed the pinned-binary/private-listener check with `Cannot read properties of null (reading 'HostIp')`; the other 11 checks passed. `Object.values(ports).flat()` retained null values for unpublished container ports, while the fixture type incorrectly described every value as an array. A standalone reproduction with a null-valued port map produced the original TypeError. The local Docker Desktop collector currently reports only its published 4318 mapping, explaining why the original assertion did not exercise this shape locally.

The fixture now types each map value as an array or null. The shared private-binding assertion skips null entries, still requires at least one actual publication, and checks every published `HostIp` equals `127.0.0.1`. Compose checks remain unchanged. Added a deterministic regression for mixed null/private entries, no ports, only nulls, empty arrays, and a valid private binding mixed with IPv4/IPv6 wildcard, non-loopback or empty host addresses. This preserves the existing host-publication policy; see [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/) for the host binding distinction. No production code, dependencies, published ports or timeouts changed for this correction.

Tools typecheck and targeted ESLint passed. The first full local run passed the null regression and original listener check but finished 9 passed / 4 failed: the compiled API startup timed out, preventing the trace test from starting its snapshot agent and causing three downstream failures. Its API log was empty. A subsequent direct compiled API module import completed in 2193.79ms; this does not establish a root cause for that startup timeout. The unchanged full suite was rerun in isolation with fail-fast enabled; final results follow below. Earlier failed attempts are not counted as passes.

Final `pnpm test:failure:dependencies --reporter=verbose --bail=1`: **13 passed, 274.14s**, including the new null-map regression, actual pinned configuration/listener inspection, distributed tracing, core/optional fault alerts and stale-agent recovery. This is local verification of the fix; the remote Linux CI job has not been rerun from this checkout. Existing 08C changes are preserved and the next implementation gate remains 08D. No commit/push was performed.

Cleanup/preservation rechecked: original two-user/eight-marker fingerprints still match, no non-system database besides `chat` and zero LiveKit rooms, original eight dependencies healthy and LiveKit running. The label-checked `commonroom-phase08ci-mail-fbb8a915` receiver was removed; both disposable telemetry projects cleaned up. No checked task listener or telemetry fixture agent lock remains. Existing development data/mail and unrelated containers/volumes were preserved.

## Phase 08D: actual release overlap and interrupted work (2026-10-19)

Entry: clean `75c8292`, containing committed 08C and CI fix. Original development fingerprints matched the 08C checkpoint; original eight dependencies healthy and authenticated LiveKit had zero rooms. No new production/domain behavior, dependency or migration was required for D. The implementation adds ignored prior artifact preparation, bounded test-only IPC drivers, compatibility/interruption tests, an isolated SFU/mail browser launcher, CI gates and [upgrade runbook](runbooks/upgrade.md). The implementation plan recorded architecture/ordered acceptance before edits. No commit/push/deploy was performed.

### D1/D2 actual artifact and transport evidence

`f4396e3782b57050d62561ac0dab8a0a844f4bc5` was archived from Git, independently frozen-installed under its normal package policy using existing cache/store and compiled under `.cache/upgrade-artifacts/f4396e3`. The prior API/domain resolve their own declared internal dependencies inside that artifact. Current compiled modules resolve inside the current checkout. Entrypoint/lock hashes and resolved module paths are recorded; these are trusted local provenance checks, not signed or recursive malicious-cache attestation. Prior domain SHA256 `355fd762f323d225f9c3f34829a8acd2dc4c9a96767507a21c51efcfe54d9898`, prior API `e6df52b054a2ca4d9d365d1f9f81f650f57811c8fc7615a786388680b42a8df1`, prior lockfile `50a34c7830b6565c39371d64430a2382653ee4b58e1b8aba95917f3b76fb04cc`. Current domain at base 75c8292 `12884f966aa27b78db32f00ca5b487454dc17bec5a1d29e6166e57844540c288`; current API `691014dc7a136fe05712afb679e6b56b060673aa80758e91714aeb876066c548`.

The first complete backend drill passed **7 checks, 110.35s**. It was then strengthened to create actual old/current compiled HTTP API listeners on separate loopback ports in the two persistent artifact processes. That complete run passed **7 checks, 116.36s**. A final guard-refinement rerun and affected regression totals are recorded below when complete; reruns are not counted as distinct additional tests.

Executed cases:

- Prior migration creates seven markers. An old writer creates actual users/group/message; current applies additive 008, both versions rerun migrations without changing marker fingerprints. Applied source-file hashes remain unchanged. No down-migration/drop/reset is used.
- Both real HTTP APIs concurrently accept the same strict v1 command with one accepted reference/message. Both reject a conflicting HTTP retry with 409. Cross-version old/new service retries preserve references, extra fields fail 400, outsiders fail authorization and an old writer obeys a current membership removal. A prior writer remains usable against schema 008 for the supported ordinary-database rollback window.
- Actual old/current Rabbit publishers and consumers run together with 20 alternating-version messages and control events. Both consumer processes commit effects; each canonical subscription effect and fanout/notification job exists once. Unpublished work drains to confirmed publication.
- A current owner stays alive past its real 30-second lease. Prior process takeover confirms publication; the released stale owner is refused, and the replacement completes. No test rewrites lease time to accelerate this case.
- A prior owner is actually killed after broker confirmation but before marking published. Another artifact waits the real deadline, republishes and completes attempt 2 with unique durable effects/jobs.
- A prior consumer is killed after its transaction commits but before ACK. Rabbit redelivery is observed as a duplicate by the current consumer; its job remains unique.
- A current allocator is killed after actual provider room creation but before its database room-ready transition. Its claim remains pending/leased until real expiry, another process reconciles it to ready, and only the expected namespace-owned provider room exists. Cleanup removes it.

`upgrade_test_<uuid>` guards reject ordinary development, system and `restore_*` targets before process creation. The prior binary lacks `restoreControl` and invalidated-empty-password handling; restored targets require current fence-aware binaries. This supported overlap does not imply restore rollback safety. Node hard termination was executed on Windows; Linux POSIX application termination/orchestrator behavior remains unexecuted locally. The separate SFU case below kills an actual Linux container process.

### D3 actual SFU crash and visible browser rejoin

The launcher provisions an isolated pinned LiveKit and Mailpit on random loopback ports, with bounded CPU/memory/PIDs and label-guarded mutations/cleanup. Effective media HTTP/TCP/UDP bindings are inspected. Provider runtime credentials live in an ignored config written with requested mode 0600 (Windows inherits workspace ACLs), mounted read-only, never CLI arguments/committed fixtures; the config is unlinked after container removal. Original provider/mail/volumes remain running.

Final strengthened browser run: **1 passed, 45.0s** (test body 24.7s). Actual generated Chromium media was exchanged by two independent accounts. An outsider's HTTP join was 403 before and after. The owned Linux SFU received SIGKILL, Docker reported exit **137**, authenticated provider health failed and visible media left connected state. After restarting that same disposable container, reconciliation replaced generation **1 with 2** and a new room name. Visible stop/rejoin controls were used; both pages then had decoded remote video (>5 frames) and received audio (>100 bytes) on currently connected peer connections. The old room was absent, only one current room remained, ending cleared remote media and provider rooms reached zero. This verifies actual media after recovery, not only a token or backend flag.

Ignored `.cache/upgrade-media-4ec6ce2683fd/evidence.json` records **11122.39ms** from the crash request through room recovery, visible rejoin actions and verified media, two authorized peers and outsider denial, without tokens or media content. This is one small local same-host observation including polling/control interaction, not production RTO/capacity or uninterrupted media. Generated devices do not establish native camera/microphone behavior, Safari, forced TURN or Linux browser webhook routing. No webhook success is inferred; provider polling drove reconciliation. The separate Phase 06/07 gates stay open.

### Failed attempts and corrections

An unsupported pnpm cache flag caused an initial CLI parse refusal. The native pnpm store operation lock required ordinary authorized tool execution outside the filesystem sandbox. Offline metadata was initially searched under the extracted artifact rather than the shared cache; universal `config.cacheDir` fixed that while retaining normal lock/policy checks. A full-hash directory then exceeded the native Windows task-state path budget; the short, full-commit-validated artifact directory compiled successfully. Failed setup archives/directories remain ignored for review; none were relabeled as successful artifacts.

The first child startup assumed the old domain declared the later observability dependency; it did not. Validation now follows each artifact's actual declared internal dependencies, without forcing a new dependency into the old release. Those setup failures skipped the suite and are not passes. Typecheck/lint caught unsupported public access to MongoClient topology and missing JS Node imports/null stream handling; corrected and checked again. Namespace cleanup uses an explicit ownership flag and synthetic-user/room-prefix checks.

The initial browser version passed in 55.9s. Its stronger rerun overlapped a workspace rebuild and failed with a missing selected call panel; a Vite development reload can invalidate local UI state, so that run is not used as evidence. The next stable run reached a new connected room but failed the combined post-rejoin media-counter predicate. The existing call suite explicitly scrolls remote video into view for adaptive subscriptions; the drill now does the same and checks live decoded-frame/audio counters separately. The final strengthened run above passed. No domain behavior or product timeout was weakened to make these cases pass.

### Final D4 verification and preservation

The guarded backend suite passed **7 checks in 113.91s**, followed by messaging **8 in 19.90s**, calls **12 in 38.09s**, operations **10 in 64.53s**. A final full refinement enabled real current HTTP tracing, proved a current row's valid optional `traceparent`, and had the actual prior relay claim/confirm/preserve that row: **7 passed, 115.18s**. Its exporter is explicitly bounded to a closed loopback port; collector delivery remains the separate already-recorded 08B gate, not an inference from this test. The final API declared-dependency location guard passed in a focused HTTP overlap check: **1 selected / 6 unselected, 16.76s**. These reruns are not extra distinct tests.

Distinct current-session regressions: **80 backend/unit/HTTP + 1 browser = 81 passed**: 40 unit, 3 HTTP, 8 messaging, 12 calls, 10 operations, 7 upgrade and 1 isolated upgrade browser. Root build, all workspace/tools typechecks, full ESLint/import boundaries, browser secret-name scan and whitespace check passed. Existing >500kB build warning remains. The wider consolidated 08E full suite, remote Linux CI and the independent Phase 06/07 gates were not executed/closed by D.

Final read-only fingerprints match the 08C checkpoint exactly: two ordinary development users and eight markers; private result `.cache/phase08d-preservation.json`. No non-system database besides `chat`, zero original-provider rooms, no `commonroom.upgrade` Docker containers, no generated provider credential configs and no checked application/telemetry/drill listeners remain. Original eight dependency containers healthy; authenticated original LiveKit available with zero rooms. Original source/volumes/buckets/mail retained. Applied 001-008, original brief and lockfile have no Git differences; applied 008 SHA256 remains `19F89390A30B85DE42E25BAFD2FD05452FF43B445B2FA382DC6A1953EFE909FB`. Ignored provenance/build/evidence/private diagnostics remain; failed setup caches were preserved, not treated as ready artifacts. No active verification session, commit/push/deployment performed. Resume at **08E** in the latest implementation-plan checkpoint; 08D is locally verified and full 08 remains in progress.

## Phase 08E final local consolidation - 2026-10-19

The [consolidated E report](phase-08e-evidence.md) supersedes the D resume point: **210 backend/unit/HTTP + 19 browser = 229 distinct checks passed**, including the new real-service lifecycle regression, actual release overlap/restore/dependency alerts and killed-SFU browser recovery. Final frozen install/build/typecheck/lint/Compose/production audits/secret-boundary/protected-byte checks and preservation passed. A teardown race was found despite initially passing browser assertions and corrected with fresh UUID ownership and cleanup after web-server shutdown. One later group-call timeout/Chromium codec collision was preserved; unchanged calls then passed, and its cause remains a Phase 09 reliability-audit task. The failed CLI itself verified cleanup of owned state. Full attempts, timings, correction and limits are retained in the E report.

No live fixture/session remains. Original account/schema fingerprints match, original dependencies/volumes/mail remain, no test DBs/rooms/credential configs/checked listeners remain, and the brief/lock/applied migrations are unchanged. Local Phase 08A-E gates are complete within their recorded scope. Platform/production validation, native positive push and forced TURN/Linux browser routing remain open. Resume **Phase 09A** using the final implementation-plan checkpoint; 09 is not implemented/verified. D/E remain uncommitted on 75c8292; no push or deployment performed.
