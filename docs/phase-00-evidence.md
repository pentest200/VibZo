# Phase 00 evidence

Date: 2026-10-13 (Asia/Calcutta). Status: **Phase 00 foundation verified**. This does not verify any Phase 01–09 features.

Host: Windows PowerShell / Node 22.15.0 / npm 10.9.2 / pnpm 12.11.2 / Docker engine 29.7.2 / Compose 5.5.0. Initially engine pipe absent and no Docker process; Desktop absent from the usual Program Files path. Located the existing user-local installation under AppData/Local/Programs/DockerDesktop and started it hidden. Its engine worked after sandbox escalation. Infra runner uses repository-local Docker config with installed plugin discovery, avoiding the inaccessible user credential file.

| Check (root unless stated) | Actual result |
| --- | --- |
| `pnpm build` | PASS all apps/packages; web bundle generated |
| `pnpm typecheck` | PASS app/package + tools/integration/HTTP/unit test sources |
| `pnpm lint` | PASS ESLint + browser/server import boundaries |
| `pnpm test` | PASS 32 tests across 4 files |
| `pnpm test:foundation:http` | PASS 3 tests; real Nest/Fastify HTTP, liveness during unreachable DB, 503 readiness/security headers/metrics/no placeholder auth route |
| `pnpm infra:config` | PASS all baseline/media/scanner profiles; syntax only for optional profiles |
| `pnpm infra:up` | PASS five healthy baseline probes, replica initialization, private buckets/grants; repeat start PASS |
| `pnpm test:integration:foundation` | PASS 6 real-service tests; repeated PASS after containers recreated with digest pins |
| `pnpm install --frozen-lockfile --offline --state-dir .cache/pnpm-state` | PASS in populated workspace (escalation required for pnpm machine operation-lock access) |
| Isolated fresh install + build | PASS frozen install and all app/package builds from `.cache/clean-checkout-phase00` without prior node_modules/dist, sharing only package/metadata cache |
| `pnpm audit --prod --audit-level high` | PASS: registry returned “No known vulnerabilities found”; not proof of complete security |
| Compiled gateway/worker startup | PASS: real child processes return live 200 and functional readiness 503; processes stopped afterward |

Real integration checks: Mongo writable replica set and majority+journal snapshot transaction commit/rollback of two collections, exact `9007199254740993` Long persistence, positive API readiness, Redis authenticated PING/TTL, Rabbit confirmed persistent publication to three independent durable quorum test queues/manual ACK, quarantine/approved S3 read/write/delete plus unauthenticated denial, Mailpit readyz and actual SMTP 220 greeting. Test databases/queues/exchange/objects cleaned. This is a foundation smoke, **not** proof of message idempotency, lost ACK, outbox crash recovery, redundant topology or production capacity.

Baseline actual pulled image digests recorded and pinned in Compose: Mongo `d0d926f94df099bff534b7ee5b5986458131a22489dfff8664509af0c1e2ca9c`; Redis `3811787313eba226a2ef38658c6ccb91cd5e110edc89c37767de373120a0e5a0`; Rabbit `3ef7f7e89fed709a78f79b8b5f4e30e1312a1d4089da752e23595566d9d61a95`; Garage `9c96caa2612d3411acc5b0e6701fb238dbfba33e533a6d7d3d811a4b12d0d020`; Mailpit `94f6b70c1436defae6799d9ac7ff0eeff9540465b842026d5cdb018f1c0234ea`. All SHA256.

Failed attempts corrected: pnpm ignored legacy `onlyBuiltDependencies`/`.npmrc` settings; switched to `allowBuilds` + YAML caches. Deprecated prom-client replaced with official @prometheus-io/client. Build found Zod boolean default types/Node types/API export annotation issues; corrected. Unit tests caught BigInt conversion throwing on invalid sequences; guarded conversion and tests pass. Isolated Docker config initially hid Compose plugin; added installed-plugin directory. Approved-bucket creation now checks existence. First clean offline copy lacked metadata cache; a CLI cache override attempt used unsupported flag parsing; final isolated install used explicit shared-cache paths in YAML, frozen resolution and 276 cached packages, then built successfully. A fresh-copy build exposed broader Tailwind automatic source detection without the root ignore context; set an explicit web source directory and rebuilt both copies. Their final CSS/JS asset hashes match. These failed attempts were not counted as passes.

Unverified: browser visual/a11y QA, remote Linux CI, optional LiveKit/ClamAV image/runtime probes, actual scanner/media/TURN integration, all product features in 01–09, exported OTel tracing/Grafana/alerts, production security/HA/backup/load objectives. Current measurements are local smokes, no production benchmark.

Services remain running locally on loopback with retained volumes. HTTP/manual process test app servers stopped. Resume **Phase 01** from the exact ordered task list at the end of implementation_plan.md. No paid service/public deployment/external account modification occurred.
