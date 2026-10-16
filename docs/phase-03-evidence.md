# Phase 03 evidence

Session: 2026-10-16, Asia/Calcutta. Windows/PowerShell, Node 22.15.0, pinned pnpm 12.11.2 and existing loopback Docker foundation. All Phase 02 changes were preserved uncommitted. The only dependency manifest addition links the already pinned/cached amqplib 2.2.0 into the server domain package; lockfile updated, no version upgrade. No deployment, real external account/provider or paid service.

Implemented: additive 003 messaging schema/index migration; stable original command digest/reference acceptance; transactional text/reply send with shared membership/block guards; strict global outbox admission; per-subscription projection admission; leased confirm-based outbox relay; versioned body-free broker references; independent quorum fanout/notification subscriptions; transactional local effect dedup/job writes; bounded TTL retries and DLQs with confirmed handoff; authenticated/audited bounded replay CLI; worker reconnect, messaging readiness and metrics; independent email maintenance; real composer, stable-ID retry, reply controls, polling/history persistence and responsive browser checks. See [messaging runbook](runbooks/messaging.md) for exact boundaries and incident/replay procedures.

## Executed gates

| Gate | Observed result |
| --- | --- |
| Baseline `pnpm infra:up` | PASS: existing five services healthy, volumes retained |
| Cached `pnpm install --offline --state-dir .cache/pnpm-state` | PASS: pinned dependency linked; supply-chain check passed |
| `pnpm db:migrate` | PASS: 001/002/003 applied to development DB |
| `pnpm build` | PASS: all apps/packages including final independently scheduled worker |
| `pnpm typecheck` | PASS: final all-source check |
| `pnpm lint` | PASS: final ESLint and browser import boundary |
| `pnpm test` | PASS: 39 unit tests |
| `pnpm test:integration:messaging` | PASS: 8 real-service tests, final run 16.39s |
| `pnpm test:failure:outbox` | PASS: 12 real broker/worker failure tests, final run 92.95s |
| `pnpm test:integration:conversations` | PASS: all 16 existing Phase 02 tests |
| `pnpm test:integration:auth` | PASS: all 14 existing auth tests |
| `pnpm test:foundation:http` | PASS: all 3 HTTP tests |
| `pnpm test:integration:foundation` | PASS: all 6 real-service tests after Rabbit recovery |
| `pnpm test:e2e:messaging` | PASS: final corrected-worker two-user journey, 33.2s total |
| `pnpm test:e2e:conversations` | PASS: final corrected-worker three-user journey, 45.9s total |
| `pnpm test:e2e:auth` | PASS: both existing auth journeys, 27.4s total |
| `pnpm audit --prod --audit-level high` | PASS: no known vulnerabilities returned |
| Remote CI | New gates configured; no remote execution claimed |

## Verified behavior

The send integration suite checks real HTTP identity/CSRF/verified-member enforcement and immediate visibility of committed message/event/outbox/inbox/command records after acceptance. Lost-result retry returns the same reference. Same normalized command under concurrent calls stores one message; changed concurrent content yields one success and one conflict. A test-only future edit leaves the original acceptance reference unchanged without retaining the original body in the command result. Concurrent sends preserve contiguous exact Long sequence values above 2^53. Reply tests cover same-conversation visible messages, pre-join/foreign/deleted/missing targets, and explicitly rejected attachments. Lower configured length and sequence exhaustion reject with all transactional effects rolled back. Actual send/removal/block races enforce later permission loss, including duplicate retries. Independent users/conversations race at outbox cap one and only one succeeds. A separate legacy 002 fixture upgrades with pending outbox/event bytes preserved; migration rerun does not replace a later optional validator field.

The final failure suite uses actual RabbitMQ and Mongo, isolated namespaces and test-only fault fixtures:

1. Publisher confirms precede published state; independent subscriptions commit separate effects/jobs; duplicate publication leaves exactly one tested local job per subscription/event.
2. A separate Node process actually exits with code 73 immediately after broker confirmation, before marking published or closing connections. Its expired claim is reclaimed, the event is republished, and consumers deduplicate both confirmed copies.
3. A stale claim owner cannot complete another owner's lease; admission remains occupied until current confirmed completion.
4. Mandatory unroutable publication rejects while the durable row remains pending.
5. Unsupported versions, forged sequence references and expired canonical events go to the independent DLQs without a local effect.
6. A real Mongo projection validator fault occurs after marker insertion in the same transaction; marker/job both roll back. Confirmed TTL retry recovers after restoring the validator without duplicates.
7. Persistent validator failure exhausts exactly the configured two test retries into a DLQ, while the other subscription succeeds independently.
8. Closing the actual broker connection after local effect commit and before ACK redelivers; the job remains single.
9. Ordinary-user replay is denied. A test-only moderator fixture can request one audited targeted replay; expired references are refused without a second audit/handoff.
10. Concurrent fanout consumers enforce a one-job projection limit; rejected work exhausts into the DLQ without a stray marker.
11. Quorum queue pressure produces an actual publisher NACK. Pending work remains unpublished and drains after consumers free capacity. The test permits documented in-flight queue overshoot, while Mongo admission remains exact.
12. The real local Rabbit container is stopped, then restarted in a finally block. A real compiled worker continues sending account email to Mailpit during the outage, returns live 200 / messaging-ready 503, and durable REST-domain acceptance continues up to the configured cap. After server recovery, all committed rows publish and both effects converge. This is a one-node local fault drill, not cluster/partition or production HA evidence.

The messaging browser journey uses real API registration, Mailpit verification and two independent Chromium contexts. It sends, replies, receives through actual history polling, reloads stored messages, deliberately completes a real send with `route.fetch()` then drops its HTTP response before the browser sees it, and retries with the identical client ID. Exactly three total stored messages appear after reload (one original, one reply, one lost-response command). It also checks actual worker messaging readiness and outbox metrics. Desktop 1280px/mobile 390px captures `.cache/qa/messaging-desktop.png` and `messaging-mobile.png` were opened and visually inspected: real text/history/composer, readable controls and no horizontal overflow. Final repeated desktop/mobile captures were reopened and visually inspected after all browser gates passed. No refresh-safe offline persistence, delivered/read receipt, WebSocket fanout or provider notification is claimed.

## Corrections and limitations

Typecheck caught collection metadata narrowing and missing string-ID collection annotations; fixed without weakening strict types. Lint caught type-only imports and an unnecessary assignment. Browser boundary validation caught a Node crypto import in a contracts test; replaced with browser-safe global crypto, retaining the boundary check. An initial new browser attempt exceeded the 30-second cold-start allowance; the local harness now allows 60 seconds and explicitly waits for the migrated worker's functional readiness. Automatic approval review timed out before two commands executed; each was retried once through the normal approval path and ran. No bypass was used.

One pressure test initially assumed exact immediate quorum max+1 rejection and failed. The [official quorum documentation](https://www.rabbitmq.com/docs/quorum-queues#length-limit) documents overshoot while channel rejection notifications arrive. The corrected bounded test requires an actual NACK and proves retention/recovery. The runbook distinguishes this broker threshold from strict Mongo admission.

A later sequential conversation browser run timed out waiting for its first local verification mail. Review found broker retry backoff shared the maintenance loop and could delay email. The loops are now independent, sleeps cancel on shutdown, and a compiled-worker/Rabbit-stopped/Mailpit test passed. The final corrected-worker messaging, conversation and auth browser regressions all passed sequentially; the earlier failure is retained here as evidence of the correction.

Global guards serialize writers and can contend; no capacity/SLO benchmark. Quiesce pre-003 writers for upgrade; no rolling-upgrade guarantee. Durable fanout/reference notification jobs are bounded but await Phase 04/06 processors, so this phase proves those local reference effects only. Unpublished work, commands and effect markers have no automatic TTL; retention/disk alerts are later gates. Local broker is single-node. Confirm-before-mark and effect-before-ACK crashes can duplicate publication/handoff; only the tested local transactional effect is deduplicated. External SMTP acceptance-before-mark can still duplicate account email. Metrics counters reset per process; full alerts/traces/dashboard, clock-skew/drain/restore/partition/load drills remain Phase 08/09.

Status: **Phase 03 verified locally in the scope above.** All required local gates passed: 39 unit + 8 messaging integration + 12 broker/worker fault + 16 conversation integration + 14 auth integration + 3 HTTP + 6 foundation + 4 Chromium tests (102 total). No unresolved failed Phase 03 gate. App test processes stopped, isolated test databases dropped, and the final local Rabbit queue inventory returned an empty list after scoped teardown. Existing development accounts/volumes remain. Changes are uncommitted. Resume Phase 04 from implementation_plan.md.
