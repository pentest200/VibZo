# Local execution continuation — 2026-10-24

Starting source: `fe744a3fd9d67624a28b50ca5036354a35005879`, initially clean. The supplied configuration describes local development, not a staging or production target. Original dependency containers and data are preserved. This record supplements the [prior final evidence](phase-09-final-evidence.md); it does not replace its failed controls or certify outstanding external gates.

## Native push verifier correction

The first `pnpm test:push:native firefox` attempt failed at launch. A separate native launch with the workspace browser path explicitly set passed. The verifier previously imported Playwright before setting `PLAYWRIGHT_BROWSERS_PATH`; Playwright's browser registry therefore initialized before the intended cache selection. It now dynamically imports Playwright after setting the workspace path. No permission, subscription or provider API is simulated.

After this correction the same command launched Firefox 157.0, obtained native notification permission, and reached actual PushManager subscription. Enrollment exceeded the unchanged 45-second limit. The result is **failed at subscription**, not successful delivery. Local browser/listener cleanup passed; remote subscription cleanup is unconfirmed because enrollment did not return. No payload was sent and no provider/display success is claimed. Private results: `.cache/native-push-35cc082a-3039-49db-ae1d-5cc4f98304bf/result.json` (launch failure) and `.cache/native-push-9d5af6e7-23ae-4bcb-970f-164bc2d0a9d9/result.json` (actual enrollment timeout). Tools TypeScript check and targeted ESLint passed.

## Executed browser checks

`pnpm test:e2e:journey` **passed: 1 test, 3.0 minutes suite / 1.7 minutes case**. Independent users exercised real chat, offline/reload recovery, scanned attachment bytes, private/shared avatars, call selection, generated audio/video/screenshare, group permissions, reporting/moderation, blocking and account deletion. One recorded media observation had two connected peers, 84 decoded video frames and 38,538 received audio bytes. Synthetic fixture IDs/logs remain private. Log: `.cache/run-2026-10-24/journey.log`.

The first `pnpm test:a11y` result was **3 passed, 1 failed** in 3.1 minutes. The account case reached its reload/error-recovery step and Chromium returned `net::ERR_NETWORK_IO_SUSPENDED` at `page.reload()`. This is retained as a failed run; its underlying network suspension cause is not established. No test code, deadline, retry setting or assertion was changed. The single unchanged diagnostic repeat **passed all 4 cases in 1.7 minutes**, including the account reload/error/recovery step. Separate repeat artifacts: `.cache/run-2026-10-24/a11y-repeat-results/` and `a11y-repeat.log`. The initial failure trace remains at `.cache/a11y-results/` and log at `.cache/run-2026-10-24/a11y.log`. Repeated passing cases are counted once, not added to earlier phase totals.

The current integrated journey's 390px full-page chat screenshot was visually inspected. It displays the conversation, messages, composer, call actions, inbox and group/contact controls within the mobile layout. This is visual review of generated Chromium evidence, not native screen-reader or hardware certification.

## Running local application

Created the previously absent ignored `.env` from `.env.example`, using the supplied public development defaults, with calls enabled and push disabled. Started built API/gateway/worker and the real Vite development server as hidden processes bound to loopback. The initial ad hoc web launch used a nonexistent root Vite path; corrected to the web workspace's installed executable and started only that process. No application dependency change or rebuild was needed for that launch correction.

All three `/health/ready` endpoints returned **200** on ports 3000/3001/3002. `http://localhost:5173/login` returned **200**. A real Chromium smoke found email/password/sign-in controls and **zero page errors**, and the actual login screenshot was visually inspected. Private smoke result/screenshot/logs/process metadata and local start/stop helpers are under `.cache/run-2026-10-24/`. The application is intentionally left running for the user; future browser test runners must stop these owned app processes first because they reserve the same ports. Normal development registration/verification uses [Mailpit](http://127.0.0.1:8025). No known account password was changed or invented.

Final preservation comparison confirmed the original **2 users**, **9 migration markers**, original migration sources and matching recorded user/marker fingerprints, with **zero test databases and zero original-provider rooms**. The ordinary collection comparison observed changes to `outboxAdmission` and `authEmailJobs` while the normal worker was starting; all 40 historical fingerprints are therefore **not** claimed unchanged. These are mutable background-processing records; no rollback/reset of live work was performed. One earlier preservation probe intentionally encountered the active accessibility fixture, then the post-test probe confirmed no fixture databases. Original dependency containers remain running; no ordinary volume or account reset.

## External gates

The connected GitHub account returned HTTP 404 for workflow runs on `pentest200/RealTime-Chat-Application` at the starting commit. This does not establish whether the remote workflow ran or passed. No push, remote workflow mutation or deployment was performed.

Still required: an accessible hosted Linux run; compatible real native push enrollment and full account/worker/provider/display/click/restart validation; actual assistive technologies, OS zoom/high contrast and physical-device/other-browser checks; separately provisioned production TLS/IAM/rotation/HA/orchestrator, independent-host recovery/PITR/regional and capacity validation. The supplied local defaults do not provide those targets. Earlier intermittent 503 and larger load-generator censoring remain disclosed in the prior evidence.
