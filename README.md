# Commonroom

A TypeScript web messaging and calling application being built in verified phases. Read [implementation_plan.md](implementation_plan.md) for the complete architecture, invariants, phase gates and exact resume state.

**Current local scope: authentication, private profiles/avatars, direct and group conversations, durable messaging, live/offline synchronization, private attachments, safety workflows, generated-media calling and operations/recovery drills.** Mongo commits messages/events/outbox before acceptance; authoritative replay repairs missed live delivery. Pending actions survive reload and coordinate across tabs. Native positive push/provider display and forced TURN/Linux browser webhook routing remain open. Read the [auth](docs/runbooks/auth.md), [conversations](docs/runbooks/conversations.md), [messaging](docs/runbooks/messaging.md), [synchronization](docs/runbooks/synchronization.md), [attachments](docs/runbooks/attachments.md), [avatars](docs/runbooks/avatars.md), [safety](docs/runbooks/safety.md) and [calling](docs/runbooks/calls.md) runbooks for behavior and limits. This is not a production-ready product.

Phase 07 direct/group audio/video, screen sharing, removal/rejoin and native camera-denial flows pass local Chromium checks with generated test media. Forced TURN media currently fails and remains an open acceptance gate; authenticated relay allocation alone passes. Calling is disabled by default. See the [calling runbook](docs/runbooks/calls.md) for setup and the exact verification boundary.

Phase 08 local operations gates passed: tracing/metrics, process drains, private dependency alerts, encrypted recovery, prior/current release overlap and interrupted-work/SFU recovery. The [consolidated 08E gate](docs/phase-08e-evidence.md) records 229 distinct passing checks, the corrected browser teardown race and an observed group-call timeout followed by an unchanged passing rerun. See [operations](docs/runbooks/operations.md), [recovery](docs/runbooks/recovery.md), [upgrade instructions](docs/runbooks/upgrade.md) and [Phase 08 evidence](docs/phase-08-evidence.md). Production/platform validation remains open.

Phase 09A adds private profile avatars using actual scanner/image processing and private object storage. Verified owners upload in `/account`, wait for safety checks and explicitly publish; sharing defaults to self-only and can be enabled for unblocked active conversation members. Replace/remove, short-lived grants, account deletion and restore have explicit privacy boundaries. See [avatar setup and policy](docs/runbooks/avatars.md), [executed evidence](docs/phase-09a-evidence.md) and the [feature audit](docs/phase-09-feature-audit.md). Stop pre-avatar workers before accepting avatar uploads; ordinary message compatibility does not certify old-worker avatar handling. The local 09A regression gate passed 242 distinct checks (222 backend/unit/HTTP and 20 Chromium browsers); additive 009 is applied with original records preserved. 09B UX/accessibility and integrated feature audit, 09C capacity measurements and 09D clean setup/demo/final evidence remain pending.

Phase 09B local UX/accessibility and integrated-browser gates passed: 69 affected backend checks and 25 browser checks. This adds keyboard/route focus, responsive/contrast fixes, pinned axe audits and an independent-user journey through offline chat, private files/avatars, permissions, moderation and actual generated media. See [UX/accessibility validation](docs/runbooks/accessibility.md) and [09B evidence](docs/phase-09b-evidence.md). Automated checks do not certify full WCAG conformance or native assistive technologies; the active-call caption review and earlier undiagnosed group-call reliability observation remain documented.

## Local setup

Install a supported Node LTS (CI pins 24.21.0; engines also accept Node >=22.22 on the 22 line), and a Linux-container Docker engine with Compose. Baseline services plan for >=4 CPUs, >=8 GiB free RAM and >=10 GiB free disk; scanner/media/telemetry need additional resources, not benchmarked. All dependency ports bind loopback. Compose is intentionally single-node, development-only with public local credentials, no Mongo authentication and no dependency TLS.

On Windows PowerShell, bootstrap **inside this checkout**, avoiding blocked npm.ps1 and global changes:

```powershell
npm.cmd install --prefix .cache/pnpm-cli --cache .cache/npm --no-audit --no-fund --save-exact pnpm@12.11.2
$env:Path = (Join-Path (Get-Location) '.cache/pnpm-cli/node_modules/.bin') + ';' + $env:Path
pnpm.cmd install --frozen-lockfile --state-dir .cache/pnpm-state
pnpm.cmd build
pnpm.cmd infra:config
pnpm.cmd infra:up
pnpm.cmd test:integration:foundation
pnpm.cmd db:migrate
pnpm.cmd dev
```

Linux/macOS: bootstrap using `npm install --prefix .cache/pnpm-cli --cache .cache/npm --no-audit --no-fund pnpm@12.11.2`, put `$PWD/.cache/pnpm-cli/node_modules/.bin` in the shell PATH, then the same `pnpm` commands. pnpm 12 uses `pnpm-workspace.yaml` for settings; dependency build scripts default denied, only esbuild and Argon2's native binding are allowed; Nest's optional postinstall is explicitly denied. Lockfile retains exact transitive versions/integrities. Minimal release-age exceptions are version-specific, generated by pnpm for chosen packages; review them on dependency updates.

Open http://localhost:5173. API on 127.0.0.1:3000, Socket.IO gateway 3001, worker 3002. Vite proxies WebSockets, health and API to preserve same-origin browser requests. API `/health/live` remains 200 without a DB; `/health/ready` needs writable Mongo replica primary. API readiness currently checks Mongo; gateway readiness requires Mongo/004/Redis, while worker messaging readiness requires Mongo, broker and its fanout Redis connection. Readiness does not claim calls/media are available. `/metrics` exposes process metrics on local servers; production edge must restrict it. Mailpit UI http://127.0.0.1:8025, Rabbit management http://127.0.0.1:15672 (development credentials in Compose).

`.env.example` documents validated options. Built processes can load overrides explicitly with `node --env-file=.env apps/api/dist/main.js` (and gateway/worker paths) from root. `pnpm dev` uses validated development defaults or externally set environment; it does **not** auto-load `.env`. Never add secrets to frontend `VITE_*` variables. Production mode refuses defaults, insecure transport/cookies, direct-only DB discovery and scanner bypass; production topology still requires a separately provisioned and verified environment.

```text
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm test:foundation:http
pnpm infra:config
pnpm infra:up
pnpm test:integration:foundation
pnpm db:migrate
pnpm auth:benchmark
pnpm test:integration:auth
pnpm test:integration:conversations
pnpm test:integration:messaging
pnpm test:failure:outbox
pnpm test:integration:sync
pnpm test:failure:gateway
pnpm infra:scanner
pnpm test:integration:attachments
pnpm test:integration:avatars
pnpm test:integration:safety
pnpm exec playwright install chromium
pnpm test:e2e:auth
pnpm test:e2e:conversations
pnpm test:e2e:messaging
pnpm test:e2e:sync
pnpm test:e2e:attachments
pnpm test:e2e:avatars
pnpm test:e2e:safety
pnpm infra:media
pnpm test:integration:calls
pnpm test:e2e:calls
pnpm test:e2e:calls:relay
pnpm test:integration:operations
pnpm test:restore
pnpm test:upgrade
pnpm test:e2e:upgrade
pnpm infra:telemetry
pnpm test:failure:dependencies
pnpm test:integration:e2e-lifecycle
pnpm infra:down
```

`infra:up` initializes a Mongo replica set, starts baseline dependencies, creates private Garage quarantine/approved buckets and grants only the development storage identity. Repeated start must preserve volumes. `infra:down` does not remove volumes. The scanner profile starts real ClamAV, a restricted image decoder and its fixed-route proxy; it is required for attachment processing. Media remains optional; enable it on API and worker using the [calling runbook](docs/runbooks/calls.md). Network gates remain scoped to their recorded evidence. Standard tests require built shared packages; `build` comes first on a fresh checkout. Real integration tests fail on missing services; no in-memory Mongo substitute or silent skip.

Optional telemetry: `pnpm infra:telemetry` starts pinned local tools; run `pnpm ops:telemetry` in another terminal for bounded loopback snapshots. Prometheus/Alertmanager/OTLP bind 127.0.0.1:9090/9093/4318. No external alert provider is configured. Enable tracing separately on each application role; defaults remain off. The profile budgets 1 GiB container memory and additional bounded tmpfs/host overhead; it is not a measured resource minimum. [Operations instructions](docs/runbooks/operations.md) cover freshness, privacy, targets, dependency policy and stopping just these tools.

Local recovery: `pnpm ops:recovery` provides encrypted backup, separate current-policy capture and restore into a fresh fenced namespace. Supply a runtime-only independent key, stop all source writers, and follow the [recovery runbook](docs/runbooks/recovery.md). This is a local consistent-copy drill with explicit limits; it does not provide live PITR, regional recovery, zero backup RPO or automatic source cutover. Restored users require fresh password recovery; old credentials/provider jobs are suppressed before readiness.

CI includes frozen installation/build/typecheck/lint/unit/HTTP, Compose/service/transaction checks, migration/auth/conversation/messaging integration, outbox/gateway failure tests, Chromium auth/conversation/messaging/synchronization/attachment tests, real scanner/image processing and backend calling/drain checks, pinned telemetry preparation/dependency fault alerts, and workspace/processor high-severity production dependency audits. No remote CI run is claimed from local execution. Disclosed capacity benchmarks and remaining feature/browser gates remain planned.

Register at `/register`, sign in at `/login`, and manage profile/sessions at `/account`. Once verified, choose **Open conversations** or visit `/chat` to find contacts and manage direct/groups. Send text/replies and ready attachments, edit/delete your messages, react and explicitly mark messages read in the selected conversation. See the [synchronization runbook](docs/runbooks/synchronization.md) for live/offline recovery, receipt policy and bounded queues/windows. See the [messaging runbook](docs/runbooks/messaging.md) for acceptance, retries, broker/DLQ operations and limits. See the [conversation runbook](docs/runbooks/conversations.md) for invitations, history visibility, roles, blocks and group/direct permission policy. Start the worker (`pnpm dev` includes it) so verification/reset mail appears in local Mailpit. Follow each one-use email link; its fragment is removed from the visible URL immediately and kept only in memory. Refreshing a link page requires reopening the email. Production cookies are Secure/HttpOnly/SameSite with `__Host-` prefix; development HTTP uses an explicitly non-Secure cookie. Sessions last 7 days initially; one-use links last 30 minutes. See [auth runbook](docs/runbooks/auth.md) for rate limits, revocation, email retries and secret rotation.

For browser tests, set `PLAYWRIGHT_BROWSERS_PATH` to the workspace `.cache/ms-playwright` **before** `pnpm exec playwright install chromium`; the runner defaults to this cache. On PowerShell: `$env:PLAYWRIGHT_BROWSERS_PATH = Join-Path (Get-Location) '.cache/ms-playwright'`. Tests start their own API/gateway/worker/web processes on 3000/3001/3002/5173; stop your own dev run first. They claim a fresh UUID database with an independent owner marker and use real Mailpit and independent browser contexts (three users for conversations). The configured cleanup reporter runs after server teardown, verifies ownership and closed listeners, removes only owned rooms/object prefixes/broker topology, and drops the database last. Keep that reporter when customizing report output. An interrupted outer process can leave an owned fixture for inspection; never delete an unfamiliar test namespace by prefix alone. Synthetic Mailpit messages can remain locally until expiry; test evidence never includes production mail or accounts.

Development fixtures: provide `SEED_PASSWORD` in the process environment and run `pnpm seed:development`. This registers `alice_dev@example.test` and `bob_dev@example.test` as ordinary accounts; verify their local emails or request a password reset through Mailpit. Existing fixture registrations are preserved and their password is not overwritten; reset if needed. The command rejects non-development mode and has no privileged seed credentials. A local seed smoke already created these two accounts with a generated process-only password; use the reset flow to choose your own password.

## Resume

Resume at **Phase 09C** in the latest checkpoint at the bottom of `implementation_plan.md`; preserve current uncommitted 09A/09B work and applied migrations 001-009. [09A evidence](docs/phase-09a-evidence.md) records its full 242-check gate; [09B evidence](docs/phase-09b-evidence.md) records 94 affected checks, the integrated journey and manual/environment limits. Phase 09 remains in progress: disclosed measurements, isolated clean setup/demo and final deployment evidence remain. Native positive push/provider display and end-to-end forced TURN/Linux browser webhook routing remain independent open gates. Do not reinitialize the workspace or overwrite the brief. Evidence: [Phase 00](docs/phase-00-evidence.md), [Phase 01](docs/phase-01-evidence.md), [Phase 02](docs/phase-02-evidence.md), [Phase 03](docs/phase-03-evidence.md), [Phase 04](docs/phase-04-evidence.md), [Phase 05](docs/phase-05-evidence.md), [Phase 06](docs/phase-06-evidence.md), [Phase 07](docs/phase-07-evidence.md), [Phase 08](docs/phase-08-evidence.md).

Run broker failure tests sequentially with other broker/browser checks: they briefly stop and restart local RabbitMQ. A migration to 003 requires quiescing pre-003 writers. The later ordinary-database schema-007 to additive-008 window has a local overlapping-binary drill in [upgrade](docs/runbooks/upgrade.md); production rollout availability and other release pairs require separate evidence. Fanout and notification intents have separate bounded workers; push defaults off and unread discovery remains available.

The synchronization browser suite also reserves loopback 16380/16381 for its test-only real-Redis publication fault proxy. Its reduced browser buffer budget is eight; the normal public build-time `VITE_LIVE_BUFFER_EVENTS` budget defaults to 256 (validated 1..256). Export this non-secret option before web dev/build. Offline pending actions survive refresh, but a fresh private view still requires current server authorization; this is not an offline-installable app.
