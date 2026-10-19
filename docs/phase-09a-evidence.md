# Phase 09A avatars and feature inventory - 2026-10-19

Status: **A1-A4 verified locally within the boundaries below**. Entry clean `2f354f7`. At entry, the original two-account/eight-marker fingerprints matched E, no fixture databases/rooms existed, and the original eight dependencies were healthy plus authenticated LiveKit. Tested additive 009 is now applied locally, with original records preserved. The intermediate execution notes below are historical; the final checkpoint supersedes their pending tasks.

The [entry audit](phase-09-feature-audit.md) maps brief areas to implementation/prior evidence and outstanding 09B-D/earlier gates. [Avatar runbook](runbooks/avatars.md) defines limits, visibility, bearer windows, expiry, deletion/restore and old-worker rollout boundaries. No new package/image dependency or public deployment.

Implemented purpose-scoped private avatars on the existing actual upload/ClamAV/isolated decoder/job/quota/cleanup pipeline; additive 009 and purpose validators; owner settings/commands with explicit publish/CAS; default self-only/contextual unblocked active-member reads; short-lived image grants with a separate rate budget; account UI and conversation images with initials fallback. Recovery clears restored sharing/pointers/assets, accepts exact historical/current schemas, and has additional real archive tests. New avatar backend/browser and CI gates are implemented but only executions below count as verified.

Early build caught Mongo collection-info narrowing and string-ID filter types; corrected. Test typecheck caught the actual member-removal method, typed Mongo filters and inject payload type. First avatar suite: 9 passed, 1 failed because the test called `removeMember` rather than existing `remove`. Corrected fixture calls/types; **10 passed, 19.603s** on the next full run. No permission/scan rule was weakened. Migration was then strengthened with purpose/context JSON-schema alternatives; its final rerun and browser flow are pending below. Workspace build/typecheck/lint passed before that refinement; final tooling must be rerun against the completed source.

Execution journal and bounded per-suite logs: ignored `.cache/phase09a-41c8b7a1/`. Owned SMTP: `commonroom-phase09a-mail-41c8b7a1`, owner label `commonroom.fixture=phase09a-41c8b7a1`, full container ID `201b3afd89831532b6b39b366fe85a230ef8341f465471f9781318d8f97f6e8d`, loopback 1026/8026. Keep original SMTP/mail. Remove only after identity check once all suites end.

No full 09A, UX/a11y, load/production, remote CI, native push, forced TURN or platform result is claimed yet. Final counts, failures, cleanup, migration and exact resume tasks follow after execution.

The strengthened purpose/context migration passed all ten avatar checks in **23.577s**, including raw invalid-context Mongo rejection. First browser attempt failed because the test read the route before navigation produced the conversation UUID (400 instead of the expected authorization 403); fixed by awaiting the UUID route. The next run exposed the controlled sharing checkbox retaining its old visual value during an asynchronous save. Added an explicit requested state/busy notice and server-confirmed test synchronization, retaining privacy enforcement. The full two-user UI flow then passed **1 in 81.506s**: actual normalized pixels, default-private/opt-in/revocation/replacement/removal and malformed-image feedback. Failure logs and private trace/screenshots were preserved. No assertion/timeout/scan bypass was introduced.

Reviewed desktop/mobile captures; avatar panel fits and the width assertion passed. An existing unrelated **Your people** CTA overlaps its paragraph and is recorded for 09B. A subsequent privacy review removed avatar IDs from public-user projections (nullable field remains null), so search/membership metadata does not disclose a private image; current grants authorize by user/context instead. This small projection/UI refinement needs rebuilt affected avatar/conversation/sync checks after the current full backend run. CI budget is bounded at 45 minutes to include the added sequential real-service/browser gates and cold setup; remote CI execution is not inferred.

Latest execution checkpoint: affected conversation **16 / 32.136s**, sync **13 / 36.376s** and avatar **10 / 20.866s** checks passed after public-ID masking. The avatar fixture verifies metadata removal from actual normalized image bytes. Additional foreign-user and concurrent ten-candidate ceiling assertions, plus account-switch browser coverage, are implemented and still require the final rerun. UI asynchronous continuations now check that their account panel remains mounted before refetching private state; account changes remount that panel.

The initial consolidated backend run stopped at one safety marker-count assertion (18 passed, 1 expected eight rather than nine). Updated that inventory assertion without weakening authorization tests. Resumed checks passed safety **19 / 49.758s**, calls **12 / 33.314s**, operations **10 / 58.885s**, real encrypted recovery **17 / 67.904s**, release overlap **7 / 114.762s** and dependency faults **13 / 246.833s**. Recovery includes actual approved-avatar retirement and a genuine historical eight-migration archive. Release overlap covers ordinary messages on additive schema 009, not old-worker avatar processing. Session **55933** is now running the final outbox interruption group, then lifecycle cleanup. Stable final build/avatar/browser gates, original-state migration/preservation and final cleanup remain pending.

Final-source checkpoint: build, workspace/tools typecheck and lint/import boundaries passed. The first redirected build invocation stopped because PowerShell treated pnpm?s normal stderr banner as a terminating native error; reran with native exit-code checks and no execution-policy change. Final avatar backend **10 / 15.068s** passed with foreign/anonymous/cross-purpose and concurrent ten-candidate assertions. Final avatar browser **1 / 104.772s** passed with real normalized pixels, sharing/revocation/replacement/removal, malformed image feedback and logout/account-switch private-state clearing. Desktop/mobile captures were reviewed again; the existing CTA overlap remains a 09B finding. Full browser group is active in **session 57419**; 55933 has exited successfully, including outbox **12 / 74.996s** and lifecycle **1 / 3.491s**. Do not rebuild under the active browsers. Original-state migration and final cleanup still await the complete gate.

## Final local regression gate

**222 backend/unit/HTTP + 20 Chromium browser checks = 242 distinct passes across 27 commands.** The bounded journal contains 37 suite attempts and 4 failed attempts; repeats are counted once, using the latest complete successful result per command. No log/watchdog limit hit. All final browser commands passed on their first attempt against the final fixed build; earlier focused failures remain above. Elapsed seconds include process startup and cleanup.

### Backend, unit and HTTP

| Command (`pnpm ?`) | Passed | Seconds |
| --- | ---: | ---: |
| `test:integration:avatars` | 10 | 15.068 |
| `test` | 40 | 1.731 |
| `test:foundation:http` | 3 | 5.799 |
| `test:integration:foundation` | 6 | 6.848 |
| `test:integration:auth` | 14 | 15.619 |
| `test:integration:conversations` | 16 | 32.136 |
| `test:integration:messaging` | 8 | 18.842 |
| `test:integration:sync` | 13 | 36.376 |
| `test:failure:gateway` | 7 | 39.905 |
| `test:integration:attachments` | 14 | 43.920 |
| `test:integration:safety` | 19 | 49.758 |
| `test:integration:calls` | 12 | 33.314 |
| `test:integration:operations` | 10 | 58.885 |
| `test:restore` | 17 | 67.904 |
| `test:upgrade` | 7 | 114.762 |
| `test:failure:dependencies` | 13 | 246.833 |
| `test:failure:outbox` | 12 | 74.996 |
| `test:integration:e2e-lifecycle` | 1 | 3.491 |

### Browser

| Command (`pnpm ?`) | Passed | Seconds |
| --- | ---: | ---: |
| `test:e2e:avatars` | 1 | 104.772 |
| `test:e2e:auth` | 2 | 27.341 |
| `test:e2e:conversations` | 1 | 43.634 |
| `test:e2e:messaging` | 1 | 30.820 |
| `test:e2e:sync` | 6 | 93.960 |
| `test:e2e:attachments` | 1 | 38.836 |
| `test:e2e:safety` | 4 | 56.346 |
| `test:e2e:calls` | 3 | 74.398 |
| `test:e2e:upgrade` | 1 | 52.345 |

The new avatar cases use actual private storage, ClamAV and the isolated decoder, including PNG metadata removal into normalized WebP, overwritten quarantine isolation, spoof/pixel-budget rejection, scanner outage/retry, default-private and contextual grants, foreign/anonymous/cross-purpose denial, stale/concurrent publication, candidate/account quota, expiry/physical cleanup, deletion, missing approved bytes and HTTP CSRF/origin/schema controls. The browser decodes real pixels and exercises owner/peer opt-in, revocation, replacement, removal, malformed upload feedback, mobile width and logout/account-switch clearing. These checks do not certify every file format, hardware or browser branch.

Real encrypted recovery passed 17 checks, including current avatar retirement and a genuine historical 001-008 archive restored with eight markers before additive migration. Current ordinary-message prior/current overlap passed seven, and actual killed-SFU/rejoin passed one browser case. Pre-avatar workers still must not process avatar work. Calling passed three on this run without retries; the earlier Phase 08E group timeout/Chromium VP8 collision remains undiagnosed and assigned to 09B. Intentional media interruption emits SDK reconnect/closed-peer messages and Vite connection errors; these are retained in the private logs.

## Final tooling, migration and preservation

Final root build, all workspace/tools typechecks, ESLint/import boundaries, normal-policy frozen offline installation, all-profile Compose validation and both workspace/processor production audits passed. Both audits reported no known production vulnerabilities when executed. The existing >500kB web chunk warning remains. Final built-browser secret-name, local Markdown target and whitespace checks passed. No dependency/image pin or lockfile changed. No remote CI execution is claimed.

After all suites exited, the read-only E comparison found the exact original two-account/eight-marker fingerprints, zero fixture databases and zero original-provider rooms. Captured fingerprints of all **40 pre-existing ordinary collections** (excluding migration-lock/marker bookkeeping), applied 009 with `pnpm db:migrate`, then compared them again: **all unchanged**. An idempotent CLI rerun retained all nine marker identities and original records. The first CLI message still named only 001-008; corrected its status text to include 009, then reran CLI, preservation, typecheck and lint. This output-only correction does not affect the tested application build.

Private final checkpoint: `.cache/phase09a-preservation.json`; original-record baseline: `.cache/phase09a-ordinary-records.json`. Original user fingerprint `96a438f46142093c0e561d23c7c79e7db931ea3a57b788d0dd21a428dd456bd0`; original eight-marker fingerprint `456b3ff82aa79d7040dfcc4a92f21def507132ef6e5015efa59c16f0870081ac`; current nine-marker fingerprint `9102b4958dabf63a97ad27c73dc5db56bab7a33e0035509fb3b48a38b8a6c665`.

Applied 008 source SHA256 remains `19F89390A30B85DE42E25BAFD2FD05452FF43B445B2FA382DC6A1953EFE909FB`; applied 009 source SHA256 is `be0501e282ff7c5765121ce2a515c3715381044656e8cbfd5f0f17120200ea19`. Preserve both and all earlier migrations. Original brief, lockfile and applied 001-008 sources have no Git differences; the migration registry only adds 009.

The exact identity-checked 09A SMTP container was removed. Original eight dependency containers are healthy; original authenticated LiveKit remains available. Original service data/volumes/buckets/mail and unrelated containers are retained. No owned upgrade container, telemetry fixture volume/network, generated provider config, agent lock, checked task/proxy/mail/telemetry TCP listener or verification Node process remains. Zero fixture DBs and provider rooms were confirmed. Durable logs, private failure screenshots/traces, build caches and preservation fingerprints remain ignored; no live fixture is needed to resume. All sessions listed above and final verification sessions have exited.

## Remaining work

09A is complete within this local scope; **Phase 09 as a whole is still in progress**. Resume at 09B using the latest [plan checkpoint](../implementation_plan.md): repair the observed CTA overlap, perform systematic desktop/mobile keyboard/focus/contrast/announcement/error review, add meaningful a11y and consolidated browser targets, execute an integrated multi-user feature journey, and investigate the existing group-call reliability observation without weakening media assertions or time budgets. 09C is bounded disclosed chat/media/combined measurements; 09D is isolated clean setup/demo and reconciled final deployment evidence. Current regressions do not replace those gates.

Native positive push/provider display, forced TURN/Linux browser webhook routing, other browsers/hardware/restrictive networks, Linux application signal/orchestrator behavior, production TLS/IAM/HA/PITR/regional recovery/key custody/capacity and remote CI remain open. Image grants retain their documented <=30s bearer window; decoded pixels and retained encrypted backups cannot be recalled. No commit, push, deployment or external-provider send was performed. Current uncommitted work is based on `2f354f7`.
