# Dependency-suite broker setup correction

Status: locally verified. All 13 dependency cases, 12 outbox cases, 5 broker regressions and 41 unit checks passed, with build/types/lint. Hosted CI rerun and the precise original broker failure cause remain unconfirmed.

The supplied CI output skips all 13 cases because `beforeAll` fails at `BrokerTransport.open`. Teardown then attempts another full topology-creating open and throws before closing the fixture database, proxies or telemetry stack. The original exception is discarded, so the supplied text cannot distinguish a handshake timeout, authentication rejection or topology error. Do not infer an OOM, resource alarm or credential failure from that generic message.

## Changes

- Broker opening retains only finite stage/reason classifications and whitelisted AMQP reply codes. Raw transport messages, endpoints, usernames/passwords, topology identifiers and original exception causes are not attached. Normal publication errors keep their generic message. Production connection timeouts, publisher-confirm deadline, queue/event contracts and outbox behavior remain unchanged.
- Dependency fixture setup admits at most five attempts for transient **connect-stage** timeout/refusal/closure, with 100/200/400/800ms backoff. Each attempt keeps the configured connection timeout. Successful readiness includes the actual confirm channel and canonical topology. Authentication, permission, incompatible queues and unknown failures are not retried; none of the actual outage assertions use this setup helper.
- Test-only topology cleanup opens its connection/channel without declaring any exchanges or queues. It can delete partially created or incompatible fixture topology without trying to recreate it. Production mode and database names without an isolated UUID suffix are refused before connecting.
- Dependency teardown attempts each resource cleanup and then reports collected errors. A failed broker cleanup no longer prevents database/proxy/telemetry cleanup. The fixture's auth/database/client close path uses `finally` to release subsequent resources when an earlier close step fails.
- CI runs the dedicated broker setup regression before dependency drills and captures RabbitMQ resource alarms on failure alongside existing process/health/server diagnostics.

No skipped/relaxed fault assertions, automatic test retries, changed production retry policy, raised production timeout or queue reset was introduced.

## Executed checks

| Check | Result |
| --- | --- |
| Unchanged dependency bootstrap diagnostic selection | 1 selected case passed / 12 excluded, 28.11s; not a full-suite result |
| Workspace build | Passed |
| Full workspace/tools typecheck | Passed |
| ESLint and browser import boundaries | Passed after correcting a type-only import |
| Unit suite | 41 passed across 8 files, including broker diagnostic privacy |
| `pnpm test:integration:broker-setup` | 5 passed, 14.40s |
| `pnpm test:failure:dependencies` | All 13 passed, 279.10s; no skipped tests or automatic retries |
| `pnpm test:failure:outbox` | All 12 passed, 110.79s, including actual broker outage/recovery |
| Final tools typecheck and diff whitespace check | Passed |
| Preservation | Original 2 users, 9 migration markers and all 40 collection fingerprints match; zero fixture DBs/rooms/telemetry containers; broker restored and no alarms |

The five targeted regressions use real local RabbitMQ and isolated UUID namespaces. They force a first TCP handshake failure and verify the next connection plus canonical topology; verify actual AMQP 403 is fatal after one connection and contains no supplied username/password in the resulting diagnostic; create a classic/quorum mismatch, require a 406 topology failure, remove partial topology without declarations and reopen successfully; force broker cleanup failure while proving the actual owned Mongo database is gone and proxy cleanup ran; and reject ordinary/production cleanup before connecting. No fake provider success or broker/data volume reset is involved.

The first full dependency attempt passed 9 cases but failed the API-child startup deadline in the distributed trace case. Three later state-dependent alert cases then failed. The child log was empty at the configured error log level; that attempt is retained and not counted as a passing gate. The isolated trace case subsequently passed with the original deadline (1 selected / 12 excluded, 35.16s). The second complete sequence then passed all 13 cases, followed by all 12 outbox cases. The exact first local child-startup cause is not isolated, and no application startup deadline/assertion was enlarged. A passing rerun does not establish that this intermittent startup observation is resolved.

Private logs are retained under `.cache/ci-dependencies/`, including `baseline.log`, `build.log`, `typecheck.log`, the initial `lint.log` and corrected `lint-final.log`, `unit.log`, `broker-setup.log`, `dependencies-final.log` (failed first full attempt), `trace-isolation.log`, `dependencies-final2.log` and `outbox-final.log` when available. No commit, push or remote workflow trigger is authorized or performed by these local checks. Existing Phase 09C media/load failures and Phase 09D remain separate.

Final preservation reports are `preserve-final.log` and `records-final.log`. All verification processes exited. Original service volumes remain intact; the outbox fault test temporarily stopped/restarted RabbitMQ and verified recovery. All eight original dependency containers are healthy, authenticated original LiveKit inspection succeeds, RabbitMQ reports no alarms, and owned telemetry fixtures were removed. No ordinary queue/data reset, migration/dependency/lockfile change or deployment occurred. The 71 passing checks count the four final suites once; selected diagnostics and earlier failed runs are not added to that count.
