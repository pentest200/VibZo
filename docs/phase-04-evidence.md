# Phase 04 evidence - verified locally

Local date: 2026-10-16. Started from clean commit `0f7555c` (Phases 02/03 committed by the user). Phase 04 changes remain uncommitted. Existing work and local volumes were preserved. No deployment, real provider/account change, paid service or privileged default account.

Implemented: additive `004_sync`; independently runnable authenticated WebSocket gateway; actual Redis adapter and leased fanout worker; bounded reference replay, retention floors and materialized owner-bound expiring snapshots; authoritative inbox repair and unread counts; user-scoped IndexedDB projection/cursor transactions, pending actions, multi-tab leases and invalidations; edit/delete/reaction/receipt transactions; bounded visible history, typing and approximate privacy-aware presence. See [synchronization runbook](runbooks/synchronization.md) for product policy, limits and recovery. Socket.IO/client 4.8.4, Redis adapter 8.3.0 and idb 8.0.4 were checked against registry/official APIs and pinned in the lockfile.

## Executed gates

| Gate | Observed result |
| --- | --- |
| Existing local baseline startup | PASS: five healthy services, preserved volumes |
| Pinned package installation | PASS |
| `pnpm db:migrate` | PASS: 001/002/003/004 applied to development DB |
| `pnpm build` | PASS after final gateway authorization update |
| `pnpm typecheck` | PASS: final all-source check |
| `pnpm lint` | PASS: final all-source check |
| `pnpm test` | PASS: 39 existing unit tests |
| `pnpm test:integration:sync` | PASS: 13 tests, final run 50.63s |
| `pnpm test:failure:gateway` | PASS: 7 tests, final run 33.67s |
| `pnpm test:integration:auth` | PASS: 14 tests |
| `pnpm test:integration:conversations` | PASS: 16 tests |
| `pnpm test:integration:messaging` | PASS: 8 tests |
| `pnpm test:integration:foundation` | PASS: 6 tests |
| `pnpm test:foundation:http` | PASS: 3 tests |
| `pnpm test:failure:outbox` | PASS: 12 tests, actual Rabbit stop/restore, 58.24s |
| `pnpm test:e2e:sync` | PASS: all 6 expanded scenarios, full run 1.7m; additional different-account switch extension rerun PASS, 35.6s |
| `pnpm test:e2e:messaging` | PASS: final two-user lost-response/reload journey, 28.6s |
| `pnpm test:e2e:auth` | PASS: 2 journeys, 24.8s |
| `pnpm test:e2e:conversations` | PASS: 1 three-user journey including live removal/inbox exclusion, 48.6s |
| `pnpm audit --prod --audit-level high` | PASS: no known vulnerabilities returned |
| Public buffer configuration negatives | PASS: 0, 257 and non-numeric values rejected at web build startup |
| Remote CI | Gates added; no remote execution claimed |

## Real-service coverage

The integration suite uses isolated Mongo replica databases, real Redis, Rabbit and two gateway instances, plus the separate-process fault test. It verifies sender/version enforcement and original send acceptance after edit/deletion; invisible replay positions and floor expiry; immutable owner-bound snapshot pages, quota races and explicit expiry; monotonic receipt progress and invalid future/inverted positions; exact Origin/CSRF/verified-session handshake checks; unauthorized/forged subscriptions; shared connection quotas across gateways; actual outbox/Rabbit/consumer/fanout/Redis-adapter delivery to both gateways; revoked sessions and removed membership; a pinned 101-entry inbox while new conversations/title changes occur; unread counts unaffected by own sends/edits/reactions, concurrent aggregate receipt ranges; authorized 103-message keyset windows and post-block mutation denial; actual cross-gateway typing, per-device expiring presence, privacy and block suppression; protected-command pressure bounded before dependency work. An expired inbox feed cursor does not disconnect a valid idle socket: authority reads the current counter directly.

The failure suite uses actual dependencies, with test-only faults. It tests a non-acknowledging consumer exhausting its hint budget; forged references and reversed/duplicated publication without altering durable state; session expiry on an already connected socket; a TCP proxy severing actual Redis connections while liveness remains available/readiness fails and sockets disconnect; an independently spawned compiled gateway process receiving actual Redis-adapter fanout with the other gateway, then stopped/restarted followed by canonical Mongo replay; graceful drain warns clients and releases the shared connection lease while durable writes continue; failed fanout jobs remain pending and expired owners are reclaimed before successful publication to real Redis. This is local process/dependency evidence, not a production cluster/partition proof.

The browser suite uses real registration/Mailpit, independent Chromium contexts, the API, worker, Rabbit and gateways. The six passing scenarios cover live inbox discovery, edits while another device is offline, queued offline reactions/read reports and offline delete repair; offline pending UUID survival across reload/two tabs with one logical server message and logout propagation; truthful storage-denied memory fallback; and intentionally dropped live PUBLISH operations with the recipient socket remaining connected while authoritative repair restores the message. Additional scenarios verify a delayed old snapshot response cannot overwrite another tab's newer persisted projection; logout clears pending, projection and inbox stores; signing into a different real account cannot reopen the prior account's conversation or pending actions; 103 messages navigate 100/3/100 DOM windows; a real retention-floor 409 resets the cursor; and a live burst exceeds a configured eight-hint browser budget, disconnects, then recovers every committed message without cursor advancement from the hints. The fault proxy forwards all other commands to actual Redis; it does not simulate a working provider. Default browser buffer 256 is a configured upper limit, not a measured capacity result.

Desktop 1280px and mobile 390px screenshots `.cache/qa/sync-desktop.png` and `sync-mobile.png` were captured. Both final captures were opened and visually inspected: readable actual conversation, tombstone, composer, controls, approximate presence and inbox without horizontal overflow.

## Corrections and limits

The first integration attempt had one incorrect test call (`revokeAll` instead of the real `revoke(token, 'all')`) and unhandled Redis adapter unsubscribe errors during immediate destruction. Corrected the call and drain Redis close operations after Socket.IO shutdown; rerun passed without unhandled errors. A fault-proxy attempt omitted existing Redis authentication; preserving URL credentials fixed the fixture and its full suite passed. Startup/command deadlines and command queue bounds were tightened. Lint/typecheck identified import/closure/type issues and were corrected without relaxing checks.

An early browser run timed out at login while web source was being edited; the isolated rerun passed. A later expanded run found a routing-test gap between removing the abort route and installing its recorder, allowing an unrecorded successful retry. Replaced that gap with one route whose fault flag changes atomically. The history test initially observed the first complete 100-message window while the fixture's last messages were still being hydrated; it now waits for the actual final message before checking the older cursor. The final expanded suite passed. One connected-gap attempt checked its suppression counter before the asynchronous publisher ran; it now waits for that observed fault. Initial pressure attempted 300 fixture writes against a 15s HTTP deadline; the documented configurable budget exercises overflow at eight using 25 committed messages. The final test releases the stalled response as soon as overflow occurs, and checks the actual 25-row result.

Code review found two correctness gaps: unread state was missing, and cumulative delivery could attribute old unseen messages outside the applied 100-message window. The implemented unread aggregation counts only visible undeleted incoming messages after read progress; delivery now records/merges applied ranges. Receipts intentionally aggregate per user across devices rather than retain unlimited device rows. Read is an explicit user report through a position. Previous per-device receipt-table planning is superseded by this bounded account-level aggregate policy.

Final review bounded each socket to four in-flight protected commands and rate-limited subscription attempts before database work. It also corrected idle inbox checks to read the authorized current counter rather than replay from zero after a retention floor. New real tests passed for both.

No offline authenticated-history/installable-app promise: reload requires server authorization before private views, but already-persisted actions remain for later retry. Browser storage eviction can lose unsent actions. No actual event/command/effect/content pruning yet; retention is Phase 06. Private media, scanning, notifications, reporting/moderation, deletion, calls and production operations remain Phases 05–09. Exact production capacity, TLS/edge behavior, mixed-version rolling updates, restore/partition/clock-skew and broad-browser compatibility are unverified. No exactly-once or complete-security claim.


## Completion and resume state

All required local Phase 04 gates passed: **128 Vitest/Playwright tests** (39 unit, 13 sync integration, 7 gateway failure, 14 auth integration, 16 conversation integration, 8 messaging integration, 6 foundation integration, 3 HTTP, 12 outbox failure, 6 sync browser, 2 auth browser, 1 conversation browser, 1 messaging browser), plus build/typecheck/lint, invalid public-budget checks and production dependency audit. Browser snapshots were visually inspected. Remote CI and production operational/capacity claims remain unverified.

The final preserved development database has 001_auth, 002_conversations, 003_messaging and 004_sync and both prior ordinary accounts. No isolated test databases remain for the checked test prefixes. Temporary API/gateway/worker/Vite/fault proxy listeners on 3000/3001/3002/5173/16380/16381 are stopped. All five existing baseline containers remain healthy on loopback; Rabbit was restored after its fault drill. Synthetic Mailpit mail and ignored local caches/screenshots remain. No commit was made. Next implementation is Phase 05 private attachments and real scanning; exact ordered tasks are in implementation_plan.md.


## CI follow-up (2026-10-17)

The supplied GitHub Actions log failed at the messaging browser assertion waiting for the shared composer notice 'original IDs'. That notice is ephemeral: receipt acceptance and a successful retry can replace it before Playwright observes it. Proxy EPIPE warnings were not the failing assertion.

The repaired test checks durable protocol results: the initial real POST must return HTTP 200 before its response is intentionally dropped; the successful browser retry must return the same complete canonical acceptance; every transmitted attempt must reuse the original clientMessageId; the accepted send must leave the pending queue; one copy must appear in history and all three messages must remain after reload/navigation. It no longer requires observing a transient status notice. Cold navigation checks have a 25-second bounded recovery window, matching the existing sync browser coverage, while retaining the exact three-message assertion. No automatic retries or production security limits were changed.

Validation also found a separate local SMTP setup problem. Synthetic jobs entered sending and returned to pending after the five-second greeting deadline. Both raw SMTP and Nodemailer probes could time out before a greeting. Default-config Mailpit control probes showed variable greeting delay (about five seconds in one observation, 933ms in another); an isolated Mailpit with --smtp-disable-rdns passed three immediate handshake probes and a later 10ms handshake. Compose now disables reverse DNS for the local/CI mail capture service, removing that external DNS dependency without changing production SMTP timeouts. The option was verified in the pinned image help and the [official runtime options](https://mailpit.axllent.org/docs/configuration/runtime-options/). The conversation/messaging test helper accepts MAILPIT_URL, defaulting to the existing 8025 endpoint, so verification can use a disposable instance without altering the existing mail store.

Earlier attempts are not counted as passing suites: the initial five-repeat trial had two completed journeys and three earlier verification-email setup failures, and a restricted runner stalled during cleanup and was stopped. A later healthy-SMTP five-repeat run passed four journeys and exposed the default five-second cold-navigation timeout in the fifth; its page snapshot contained the three expected messages after the timeout. That led to the bounded recovery checks above. Temporary teardown diagnostics were restored byte-for-byte; no production mail/messaging implementation was changed. The existing Phase 05 changes were preserved and Phase 06 has not started.

Final verification: **5/5 browser repetitions passed**, exit 0, in 2.8 minutes, with retries still disabled. Command: `pnpm exec playwright test --config tests/e2e/messaging.config.ts --repeat-each=5`, with a fresh `E2E_DATABASE`, `SMTP_PORT=1026` and `MAILPIT_URL=http://127.0.0.1:8026` pointing at the real isolated mail capture. Full workspace typecheck, lint/import boundaries, final tools/test-source typecheck, targeted ESLint and all-profile Compose configuration passed. Local verification used the current workspace with the preserved Phase 05 work; the test fix also uses only Phase 04 APIs and UI controls. Both disposable mail containers were removed after verification; all eight original dependency containers remain healthy, and the existing mail instance/messages were not recreated. No temporary diagnostics remain in tracked setup code. Changes are uncommitted. **GitHub Actions itself has not been rerun**; push this fix and rerun that job before claiming remote CI success. The repair is locally verified; Phase 06 remains the next implementation phase.
