# Phase 09D — clean setup, demo and final audit

Status: **full isolated local setup/demo/audit verified**, 2026-10-22; see the final continuation below. Entry commit `6dc6c5e`; existing uncommitted RabbitMQ CI correction preserved. No commit, push, remote workflow rerun or deployment. Overall Phase 09/environment acceptance remains incomplete; earlier failed/censored evidence is retained.

## Architecture and implementation

`test:setup:clean` snapshots current tracked/nonignored source into a new owned directory with SHA256 manifest, performs a frozen install into fresh dependencies and builds all packages. It retains the existing pinned Node/pnpm toolchain and package/image caches; it is not a fresh OS/toolchain bootstrap. The five baseline services are generated from canonical digest-pinned Compose definitions into a separate project, with fresh labelled volumes/network and seven distinct loopback ports. Total extra container caps are 1,472 MiB. Host preflight requires 2.5 GiB free RAM, 3 GiB disk and a Docker VM configured with >=6 GiB; these are safeguards, not full-stack sizing claims. Original services are never stopped or used as rehearsal targets.

Path/ownership guards reject source redirects, traversal, ignored dependency/build/cache trees and `.env` secrets. The runner compares the frozen lockfile to its copied manifest. Per-step logs are capped at 8 MiB, commands have finite deadlines and process-tree termination targets only their own child. Cleanup inventories and validates all project labels, independent owner labels and exact expected resource names before removing owned containers/volumes/network. It retains source/logs and treats cleanup failure as command failure. External hard termination still needs the documented checked operator cleanup.

The foundation Mailpit HTTP target now honors `MAILPIT_URL`, matching existing SMTP configuration so the rehearsal does not silently call the original receiver. CI adds the two inexpensive setup guard tests. The expensive rehearsal remains an explicit local command; it has not run on hosted Linux.

Procedures: [setup rehearsal](runbooks/setup-rehearsal.md), [concise integrated demo](runbooks/demo.md), [security/deployment boundaries](architecture/security.md). The demo reuses the existing independent-user journey and its owned provider/mail lifecycle rather than introducing a weaker duplicate suite.

## Actual execution

Original data matched on entry: 2 users, 9 migration markers, all 40 ordinary collection fingerprints, no fixture databases and no original-provider rooms. Original dependencies were healthy; LiveKit was up. Host had about 3.2 GiB free RAM and existing Docker workloads consumed about 2 GiB. No second scanner/media stack was admitted.

Clean baseline rehearsal **passed**, including cleanup, on the first attempt. Private evidence: `.cache/clean-setup-ea6f2d0faec34cca81ad3b76aa5cf3c6/`. Its manifest captures the current implementation including the broker correction and setup scripts as of snapshot time; documentation/CI edits written later are outside that snapshot. All 15 steps passed:

| Step | Observed result |
| --- | --- |
| Fresh frozen install | 13.341s; fresh source `node_modules`, existing pinned tool/cache |
| Full build | 11.864s; all application/shared packages |
| Five fresh dependencies | Ready in 12.455s, new project/volumes/ports |
| Approved bucket/grant/CORS | Actual Garage setup succeeded |
| Foundation | **6 tests passed**, 8.10s Vitest duration |
| Migrate/capture/migrate/compare | All nine real markers, exact byte equality after repeated migration |
| Authentication | **14 tests passed**, 15.48s Vitest duration; owned mail/dependencies |
| Retained Mongo restart/readiness/compare | Writable replica and all nine original fixture markers unchanged |
| Cleanup | All owned containers, four volumes and network removed; original resources retained |

Two setup guard tests passed (210ms) before the rehearsal. Tools typecheck passed. Initial targeted lint found one `prefer-const` issue in the new runner; corrected and targeted lint/typecheck passed. This correction preceded the passing rehearsal snapshot. No failed install/service/test command was retried as part of that run.

Integrated demo **passed**: one actual independent-user Chromium journey (1.7m suite duration; case approximately 1.4m). This newly executed run covered offline reaction/read/edit replay, failed send requests and stable command-ID recovery across reload, private scanned-file byte equality, purpose-scoped avatars, direct/group authority, report/moderator/block/deletion, and real generated remote frames/audio/screenshare. Private log: `.cache/phase09d-checks/journey.log`. Vite reported socket aborts around the intentional network interruption; the assertions, server teardown and cleanup completed successfully. No deadline/assertion change, automatic retry or skipped case.

Final full workspace/tools typecheck, lint/import boundaries, all **41 unit tests** (8 files, 697ms), the **2 setup guards** (186ms), all-profile Compose config and whitespace check passed. There are **64 distinct passing tests in this affected verification set**: 41 unit + 2 guards + 6 fresh foundation + 14 fresh auth + 1 browser journey. The 15 rehearsal steps are operations, not 15 additional tests; the two guard invocations count once. This is not a rerun of every previous phase suite. Frozen install/full build were verified in the source snapshot; no dependency versions, lockfile or migration source changed.

Final preservation matched the same 2 users, all 9 markers and all 40 ordinary collections. User fingerprint `96a438f46142093c0e561d23c7c79e7db931ea3a57b788d0dd21a428dd456bd0`; marker fingerprint `9102b4958dabf63a97ad27c73dc5db56bab7a33e0035509fb3b48a38b8a6c665`; 009 source `be0501e282ff7c5765121ce2a515c3715381044656e8cbfd5f0f17120200ea19`. Zero fixture databases, original-provider rooms, rehearsal containers/volumes/networks, owned journey provider/mail containers and application listeners on 3000/3001/3002/5173. No setup lock remains. Original eight dependencies healthy and original LiveKit up. Brief SHA256 remains `c098d7d37f7632be33c80dedacdf677896e6effc53b21e6b099aa61f3ca17191`. All verification sessions have exited. Logs remain under `.cache/phase09d-checks/` and the clean rehearsal directory; no original volume/data reset.

## Open gates and exact continuation

1. Full isolated scanner/image/browser/media setup is now verified by the continuation below; the earlier baseline-only run remains historical evidence.
2. Diagnose the 09C three-user call-refresh HTTP 503s using bounded safe classification/timing, preserving authority and media assertions. Larger chat/combined trials remain generator-censored. Keep failed outcomes; no measured backend knee/production capacity is established.
3. Rerun hosted Linux CI after an authorized user push. Original remote RabbitMQ cause and the precise Linux media teardown cause remain unconfirmed. Local passing checks do not close them.
4. Local end-to-end forced TURN now passes; production TURN/TLS/restrictive networks and Linux routing remain open. Native push/provider display, physical devices/other browsers/native assistive technologies, production TLS/IAM/rotation/HA/orchestrator and independent-host/PITR/regional recovery remain open. No full Phase 09/product-ready claim.

## Full isolated setup continuation

`test:setup:full` passed all **20 operations** (244.591s summed step times): fresh source/frozen install/build, five fresh dependencies, private bucket/grant/CORS setup, 6 foundation and 14 auth cases, nine-marker repeat/restart equality, new pinned Chromium download, fresh ClamAV volume, separate decoder/proxy build/internal network, then the actual integrated journey within that same isolated stack. Four guarded application ports, proxy/origins/readiness and post-server cleanup use the fresh values. The journey passed in 1.4m; an independent read observed 2 actual signed participant webhooks. All owned containers, five volumes, three networks, decoder image and provider/mail configuration were removed. Original workloads/data remained intact.

Private snapshot/manifest/logs: `.cache/clean-setup-a4d81a08f0a3461e93cba2616ae51b54/`. The first full attempt failed before services at a Vite port tuple typing error and is retained in `.cache/clean-setup-3e4833682d1b497f974cc9db422ee4e0/`. Corrected before the passing run. No source dependency, lockfile, applied migration or original brief changes. Later native-push/relay diagnostic additions are outside the setup snapshot; their independent final checks and exact remaining gates are recorded in [final local evidence](phase-09-final-evidence.md). This closes D's local clean-setup/demo/audit deliverables while preserving external acceptance boundaries.
