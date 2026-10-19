# Phase 08E consolidated local verification - 2026-10-19

Status: **locally verified in the recorded scope**. Base `75c8292`; all uncommitted 08D work preserved. Final distinct results: **210 backend/unit/HTTP + 19 Chromium browser checks = 229 passed** across 25 commands. This includes the new real-service browser lifecycle regression. Earlier failures and repeats are retained below, not counted as extra tests. Phase 09 remains planned; platform, production and independent Phase 06/07 gates remain open.

Entry preservation matched `.cache/phase08d-preservation.json`: two ordinary users, eight schema markers, no fixture databases or original-provider rooms. Original eight dependencies healthy and original LiveKit available. No original service was recreated. Disposable SMTP: `commonroom-phase08e-mail-a17c49d2`, label `commonroom.fixture=phase08e-a17c49d2`, private ports 1026/8026; preserve original mail.

Normal-policy offline frozen install passed with the existing lockfile. Stable root build, all workspace/tools typechecks and full ESLint/import boundaries passed. Existing >500kB client chunk warning remains. All-profile Compose validation and both workspace/processor production audits passed. The built-browser server-secret-name scan passed. Original brief, lockfile and applied 001-008 sources have no Git differences; applied 008 SHA256 is unchanged. Consolidated suites continue below.

Execution journal: ignored `.cache/phase08e-a17c49d2/results.jsonl`; current step `.cache/phase08e-a17c49d2/current.json`. Each suite has a separate ignored capped private log. The local runner stops on a nonzero exit and records attempt/count/timing; retries are not additional distinct tests. Backend suites are sequential, with real broker stop/start last after the other test processes/exporters exit. Browser suites run sequentially afterward, without rebuilding under Vite. The upgrade browser launcher owns its separate SFU/mail resources.

No remote CI, production capacity/HA/regional/PITR, native push display, forced TURN or application Linux/orchestrator signal result is inferred from these local tests. Final results and cleanup follow; intermediate statements below are historical execution checkpoints.

## Executed backend gate

The original 16 sequential commands passed 209 checks. The additional lifecycle gate passed after the cleanup correction, giving **210 distinct backend/unit/HTTP checks**. Times are the local runner's elapsed process seconds, including startup/teardown, rather than individual assertion latency.

| Command (`pnpm …`) | Passed | Seconds |
| --- | ---: | ---: |
| `test` | 40 | 1.899 |
| `test:foundation:http` | 3 | 4.896 |
| `test:integration:foundation` | 6 | 7.097 |
| `test:integration:auth` | 14 | 17.400 |
| `test:integration:conversations` | 16 | 33.958 |
| `test:integration:messaging` | 8 | 19.267 |
| `test:integration:sync` | 13 | 38.708 |
| `test:failure:gateway` | 7 | 43.495 |
| `test:integration:attachments` | 14 | 46.637 |
| `test:integration:safety` | 19 | 55.645 |
| `test:integration:calls` | 12 | 35.121 |
| `test:integration:operations` | 10 | 61.108 |
| `test:restore` | 15 | 75.273 |
| `test:upgrade` | 7 | 126.297 |
| `test:failure:dependencies` | 13 | 302.624 |
| `test:failure:outbox` | 12 | 76.189 |
| `test:integration:e2e-lifecycle` | 1 | 3.538 |

This includes real encrypted dump/restore and current-policy enforcement, actual prior/current binaries, natural lease expiry and killed owners, actual pinned telemetry binaries/collector/privacy/alerts and the nullable-unpublished Docker-port regression. Rabbit interruption ran last and restored the original broker. No failed attempt or retry occurred in this consolidated backend run; earlier C/D failures remain recorded in [Phase 08 evidence](phase-08-evidence.md).

## Teardown correction found by preservation checks

The initial eight browser commands all exited 0 (19 assertions), but the following preservation check **failed**: one random messaging database remained with one `inboxCounters` row. Original two-user/eight-marker fingerprints matched and zero rooms/processes remained. Bounded oplog inspection tied its drop timestamp and exactly two `sender_…` / `receiver_…` synthetic users to this run's messaging command. The former global-setup return callback dropped state while Playwright web servers were still alive, allowing in-flight work to recreate it. Application assertions alone did not verify cleanup.

Moved cleanup to a configured reporter's `onEnd`, after task/plugin/web-server teardown in the installed Playwright 1.64 runner. Setup now claims a fresh exact UUID namespace with an independent UUID owner marker, refuses existing targets, and never drops data while servers run. Final cleanup checks owner identity and closed application/proxy listeners, validates room prefixes, removes only that DB's object prefix and broker topology, and drops the DB last. No production source or migration changes. Reporter errors fail the CLI. Keep the cleanup reporter when customizing reporter configuration; an outer hard kill can still require ownership-checked operator cleanup.

Added `pnpm test:integration:e2e-lifecycle` and its CI gate. The real-service regression checks invalid/development namespace refusal, occupied-namespace and foreign-owner refusal, live TCP listener refusal, retained late work/object, and cleanup through the reporter after a failed run. It passed initially in 6.639s and after the type correction in 3.538s; repetitions count once. Typecheck first caught a missing Mongo string-ID generic in the synthetic counter fixture; corrected, then all workspace/tools typechecks and full lint/boundaries passed. A PowerShell `pnpm.ps1` policy refusal executed no gate; reran with the required `.cmd` shim without changing execution policy. A plan encoding conversion was caught and reversed without losing existing content.

Removed the legacy leftover only after proving its exact synthetic pair, run interval and sole counter; no unfamiliar namespace was dropped. A fresh identity-labeled SMTP receiver is running for the affected full browser rerun. The original 209 backend checks remain applicable because only test lifecycle/configuration and documentation changed. The additional regression makes the final distinct inventory **210 backend/unit/HTTP + 19 browser = 229**, pending the affected browser rerun and final cleanup below. All initial attempts remain in the ignored journal; browser repeats are not additional tests.

The affected rerun passed auth/conversations/messaging/sync/attachments/safety, but calls exited 1: two passed and the group-call case hit its existing 120s deadline while `browserContext.close` was pending (168.988s whole process). Chromium also logged a bundled VP8 payload-type/parameter collision; the causal relationship to the timeout is not established. No assertion, timeout, codec setting or product behavior was weakened. The complete log and failure snapshots were retained under the ignored E directory before rerunning. Importantly, the real failed Playwright CLI exercised the new cleanup path: a subsequent read-only check found **zero fixture databases and zero original-provider rooms**, with original user/marker fingerprints unchanged. The deliberately failed-result regression is separate from this actual CLI failure evidence. Calls and the queued upgrade browser drill are being rerun unchanged; the failure remains part of the record and media flakiness remains a final-audit risk.

## Final affected browser gate

All eight final commands exited 0 after the lifecycle correction: **19 distinct Chromium checks passed**. Calls passed unchanged in 65.648s, followed by the isolated killed-SFU/rejoin drill in 46.282s. The earlier timeout remains an unresolved reliability observation for Phase 09; a passing retry does not establish its root cause or production reliability.

| Command (`pnpm …`) | Passed | Seconds |
| --- | ---: | ---: |
| `test:e2e:auth` | 2 | 29.335 |
| `test:e2e:conversations` | 1 | 44.422 |
| `test:e2e:messaging` | 1 | 29.625 |
| `test:e2e:sync` | 6 | 84.696 |
| `test:e2e:attachments` | 1 | 34.604 |
| `test:e2e:safety` | 4 | 54.217 |
| `test:e2e:calls` | 3 | 65.648 |
| `test:e2e:upgrade` | 1 | 46.282 |

The result journal contains 35 suite attempts and one failed suite attempt; selecting the latest result for each of the 25 distinct commands yields 229 passes with no log/watchdog limit hit. This is a sequential local regression set, not a load benchmark or a single integrated feature-audit journey. Browser media uses generated devices and actual WebRTC transport. Forced TURN and hardware/browser certification are separate. Intentional disconnects produced Vite `ECONNABORTED`/SDK reconnect messages; the existing client chunk-size warning also remains.

## Final tooling and preservation

After all browsers exited, normal-policy frozen offline installation, root build, all workspace/tools typechecks and full ESLint/import boundaries passed again. Compose profile validation and both workspace/processor production dependency audits passed during E; no dependency/configuration pins changed afterward. Both audits returned no known production vulnerabilities at execution time. The final built-browser secret-name scan and protected-source checks passed. Original brief, lockfile and applied 001-008 sources have no Git differences. Applied 008 SHA256 remains `19F89390A30B85DE42E25BAFD2FD05452FF43B445B2FA382DC6A1953EFE909FB`.

Final read-only check matches D exactly: two ordinary development users and eight migration markers, with unchanged private fingerprints; checkpoint `.cache/phase08e-preservation.json`. No database besides `chat` and system databases, and zero original-provider rooms. Original eight dependency containers are healthy; authenticated original LiveKit is available. Original services, volumes, buckets and mail were retained. The second disposable SMTP incarnation was removed only after checking its full container ID and exact owner label. No labeled upgrade container, telemetry drill container/volume/network, generated provider credential config, agent lock, checked application/proxy/telemetry/mail listener or verification process remains. Ignored logs, build/provenance caches and private failure evidence remain; no task depends on a live fixture.

E1-E4 local gates are complete. No production application source, dependency or migration was changed by E; it adds the fixture lifecycle correction/regression/CI gate and reconciles stale runbooks. Existing D work remains intact and uncommitted alongside E. No commit, push, deployment or external provider send was performed. Remote CI, Linux application signal/orchestrator handling, provisioned TLS/IAM/HA/PITR/regional recovery/key custody and production capacity are unverified. Phase 06 native positive push/provider display and Phase 07 forced TURN/Linux browser webhook routing remain open. Exact next tasks, including the observed group-call timeout, are in the latest [implementation-plan checkpoint](../implementation_plan.md).
