# Phase 09 entry feature audit

Entry: clean `2f354f7`, 2026-10-19. This is a source/evidence inventory, not new full-product verification. Prior evidence records 229 distinct local checks. Individual branches and environments remain limited to those reports.

| Brief area | Existing implementation / evidence | Phase 09 disposition |
| --- | --- | --- |
| Auth, one-use verification/reset, sessions | `auth/service.ts`, `auth-app.tsx`; phase 01/integration/auth browsers | Integrated/a11y/error audit in 09B |
| Profile, username, privacy | Current account form and guarded profile updates; 09A purpose-scoped avatars and corrected presence copy | 09A locally verified: upload, private/opt-in display, revoke/replace/remove, deletion/restore and account switching. Full keyboard/error audit remains 09B. |
| Search, direct/group membership and roles | Conversation service/chat shell; phase 02 cross-user/race/browser checks | Full visible-action and keyboard audit in 09B |
| Durable messages/replies/edits/deletes/reactions | Messaging/sync services, synced history; phases 03/04 | Integrated multi-user journey and all errors/empty states in 09B |
| Offline/multi-tab/replay/receipts/presence/typing | Sync engine/IndexedDB and real gateway failures | Audit disclosure/focus/cursors and feature coverage in 09B |
| Private attachments | Actual ClamAV/image processing/S3 pipeline; phase 05 | Reuse for purpose-scoped avatars; preserve message attachment authorization |
| Push/fallback | Phase 06 backend and controlled browser checks | Native positive provider/display remains open |
| Reports/moderation/blocking/retention/deletion | Safety services and four browser cases | Audit role visibility and all action branches; include avatar revocation/deletion |
| Direct/group calls/screenshare/device controls | Actual local SFU and generated Chromium media; phase 07/08D/E | 09B investigates observed group-call timeout/VP8 collision. Forced TURN/Linux webhook/hardware remain open. |
| Faults, telemetry, drains, release/recovery | Phase 08A-E and runbooks | Preserve operational gates; extend recovery to schema 009 safely |
| Responsive UI/accessibility | Existing desktop/mobile assertions/captures, native controls | Complete systematic keyboard/focus/contrast/announcements audit and meaningful a11y tests in 09B |
| Capacity, clean setup, demo/deploy audit | Earlier clean build/setup evidence and proposed production design | 09C measured chat/media/combined trials; 09D full clean setup/demo/final report. No production capacity/deployment claim. |

09A acceptance/results and exact remaining work belong in `implementation_plan.md` and `docs/phase-09a-evidence.md`. These rows do not certify every visible action or all browsers.

09A visual inspection: actual 1280px/390px account captures show the new avatar panel and controls within their columns with no horizontal overflow. The synthetic test image is intentionally a black RGB fixture. An existing **Your people** panel CTA overlaps its paragraph at both sizes; record and repair this in the 09B layout/accessibility pass. This observation does not certify contrast, keyboard order or every screen.

Final 09A regression: 222 backend/unit/HTTP and 20 Chromium browser checks passed; see [executed evidence](phase-09a-evidence.md) for exact scope, failed attempts, migration and preservation. This does not close the 09B integrated-action/a11y matrix, 09C measurements, 09D clean setup/demo or the independent platform/push/TURN gates.

## Phase 09B route/control matrix

Source paths below are under `apps/web/src`; authority is always server enforced. Prior tests are evidence only within their recorded environments. New a11y/journey entries remain unverified until the 09B execution record passes; this matrix is an inventory, not blanket certification.

| Route / visible action | Source and authority | Loading, empty, error and recovery | Executed/required coverage |
| --- | --- | --- | --- |
| `/`, login/register and links | `auth-app.tsx`; strict auth schemas, rate/origin guard | Busy submit, input constraints, generic auth response, alert and retry | Prior auth browsers; B public keyboard/axe and named landmarks |
| Verify/reset/forgot | `auth-app.tsx`; hashed one-use tokens, active authority | Fragment removed, missing/used token alert, resend/reopen email; generic forgot response | Auth real emails/one-use/reset; B missing-token and recovery route scans |
| Account profile/username/search/presence privacy | `auth-app.tsx`; own active session/CSRF | Loading/retry account, busy save, constraint/error/status; conflict leaves current form | Prior auth/privacy; B account error/reflow/keyboard |
| Sessions/password/sign-out/all devices | `auth-app.tsx`; own session and password checks | Session loading/retry, busy sign-out/password, clear private stores | Auth + sync multi-tab cases; integrated final deletion revocation |
| Account avatar upload/check/retry/publish/remove/share | `avatars.tsx`; verified owner, purpose/CAS and contextual sharing | Progress/cancel, quarantine/error/expiry, explicit ready selection, initials fallback | A backend/browser; B account outage/retry + integrated private/opt-in pixels |
| Account notifications/permission/device opt-in | `safety.tsx`; verified owner + CSRF/provider policy | Unsupported/unavailable/denied copy, device/account toggles, unread fallback | Prior controlled provider fixture/denial cases; native positive delivery remains OPEN |
| Account moderation refresh/dismiss/remove | `safety.tsx`; audited moderator role | Hidden for ordinary users, empty queue, loading/error/refresh, tombstone result | Prior safety real role/decision; B nonmember moderator/report-reference journey |
| Account deletion confirmation | `safety.tsx`; own password + DELETE, resumable cleanup | Inline disclosed confirmation, failure alert, sign-out and immediate revoke; later physical cleanup | Safety deletion integration/browser; B form scan + integrated actual request |
| `/chat` inbox/invitations/pages/refresh | `conversation-app.tsx`, sync engine; active/invited scoped projections | Loading/empty/error, live plus reconciliation, accept/decline, bounded paging | Conversation/sync browser+backend; B empty inbox/invitation and role journey |
| Search/direct creation | `conversation-app.tsx`; verified discoverable target/unblocked pair | Prefix constraints/searching/empty/error/more results; direct idempotence | Prior conversation races/browser; B independent direct discovery |
| Group create/rename/invite | `conversation-app.tsx`; owner/admin authorization | Stable create ID, busy/status/error, pending/expired invitations, current title | Prior all three user conversation controls; B group form/keyboard/invite |
| Group role/ownership/remove/leave | `conversation-app.tsx`; transactional membership/role guards | Role-filtered controls, native confirm, denied/removed hides cached history, refreshed inbox | Prior owner transfer/leave/remove; B outsider 403/admin/removal denial |
| Block/unblock/list/pagination | `conversation-app.tsx`; guarded unblocked-pair policy | Confirmation, list empty/error, history retained, composer and grants disabled | Conversation/safety authorization + prior browser; B block/grant removal/unblock |
| Selected conversation/history/retry/older/latest | `synced-history.tsx`; fresh authorized replay/snapshot | Opening/recovering/empty/denied/retry; bounded historical pages and return latest | Sync tests for history/replay floors/storage denial; B mobile/forms and removed state |
| Send/reply/cancel/discard/queued retry | `message-composer.tsx`, sync engine; transaction/dedup | Draft constraints/status, upload interlock, durable pending, ambiguous-discard warning | Messaging/sync lost ACK and tab persistence; B reply and command-ID reload convergence |
| Edit/delete/reactions/read/receipts | `synced-history.tsx`; version/ownership/receipt window | Native edit/delete dialogs, optimistic queue + conflict/error/recovery, monotonic display | Prior offline edit/reaction/read/delete; B combined offline repair/read/tombstone |
| Presence/typing/live/storage status | `synced-history.tsx`, `sync-context.tsx`; approximate privacy-aware snapshots | TTL/disconnect recovery, visible storage denial and pending status, no exact-online promise | Sync/gateway failures; B integrated offline/connected convergence |
| Attachment choose/progress/cancel/check/retry/select/remove/download | `attachments.tsx`; purpose/owner/member + real scan/quota | Quarantine/rejection/incomplete/retry, pending list, URL/download failure, <=60s old grant | Attachment real spoof/EICAR/bytes/browser; B scanned file byte equality |
| Report conversation/message/reason/submit | `safety.tsx`; current content access/category/reference | Inline form, busy/error/status, durable command, no message copy | Safety role/browser; B keyboard form scan + report/moderator removal |
| Calls start/voice/video/incoming/accept/decline/cancel | `calls.tsx`; enabled/unblocked/membership and idempotent commands | Capabilities loading/error/disabled, ring expiry, action notices, authoritative state | Calls backend/direct/group browsers; B real direct journey + active-call axe |
| Calls join/rejoin/leave/end/remove | `calls.tsx`, `call-media.tsx`; current generation/participant credentials | Media connecting/disconnected/retry, stop device, room rotation, permission revocation | Prior direct/group and killed-SFU drill; B same gates with safe diagnostics |
| Microphone/camera/device/screen share/audio playback | `call-media.tsx`; native permissions, real SDK transport | Denied device alerts/listener fallback, retry, mute states, device error, audio-play button | Existing native camera denial/generated screenshare, B actual pixels/bytes/control scan; hardware OPEN |
| Media connection details/quality | `call-media.tsx`; local aggregate RTC stats | Pending/unavailable samples, no media recording, known route/quality limits | Existing stats assertions; B bounded counter snapshots, earlier VP8/close observation OPEN |
| Responsive navigation, focus/errors and reduced motion | `auth-app.tsx`, `styles.css`; native semantic controls | Skip main/chat, SPA focus/title, reflow/visible outlines, native confirms, live status/alerts | B axe + actual keyboard/reflow/mobile/contrast; native screen readers and full conformance OPEN |

09C bounded chat/media/combined measurements and 09D isolated clean setup/demo/deployment reconciliation remain separate. Retention/operator controls are backend/runbook operations, not fabricated end-user settings. Forced TURN/Linux webhook, platform/orchestrator and native positive push remain open regardless of these control scans.

## Phase 09B final local disposition

B1-B4 local automated/keyboard/reflow gates passed: **69 affected backend + 25 browser = 94 distinct checks**; [executed evidence](phase-09b-evidence.md). The four a11y cases cover 19 rendered states; two journey scans include real active WebRTC. No axe violations; the active-call caption rule returns a retained manual result. Native assistive technologies, captions/transcription, actual OS zoom/high-contrast/hardware/other browsers and every native dialog/device combination are not certified. The integrated journey and individual regressions provide concrete proof for the paths listed above, not every possible action permutation.

Fixed CTA overlap, route/main/skip focus and titles, brand label/name, avatar group ARIA semantics, selected-inbox/input contrast, narrow control wrapping and reduced motion. Full direct/group/screenshare/native camera-denial browser gate passed. New group counters show real decoded frames/audio and both auxiliary contexts closing; no VP8 warning appeared in that run. The earlier timeout remains undiagnosed, with no timeout increase or assertion weakening. Native positive push, forced TURN/Linux browser webhook/platform gates remain open. 09C measurements and 09D isolated setup/demo/final deployment review are next.

## Phase 09D current final audit — 2026-10-22

This disposition supersedes the entry inventory's future-tense descriptions; evidence remains scoped to each report.

| Area | Current evidence | Remaining acceptance |
| --- | --- | --- |
| UI/private avatars/integrated workflows | 09A/B committed; new 09D independent-user journey passed actual chat/replay/file/avatars/authority/media | Manual native assistive technology, hardware/other browsers and every error permutation are not certified |
| Full clean local setup | Fresh frozen source install/build, baseline/scanner/decoder/browser/media and integrated journey, repeated nine-marker/restart equality, actual webhooks and checked cleanup passed | Linux routing, fresh OS/toolchain bootstrap and production setup remain outside this result |
| Demo/calling | Actual offline/reload recovery, scanned bytes/avatars and generated WebRTC; strict owned TURN media/screenshare/rejoin passed | Physical devices, remote restrictive networks/TURN-TLS and Linux validation |
| Measurements | Small modes, moderate chat and latest three-user media passed; all earlier failed/censored records retained | Earlier 503 cause unconfirmed, larger profiles remain censored; no backend capacity knee |
| Operations/security/deployment | Current source boundaries and release prerequisites documented; earlier local drains/replay/restore/upgrade drills preserved | Hosted CI, precise remote broker/media cause, production provisioning/rotation/HA/orchestrator and independent-host/PITR/regional restore |

[Final evidence](phase-09-final-evidence.md) records **95 affected passing checks**, the full fresh-setup scope, actual local TURN and preserved ordinary state; the earlier 64-check baseline checkpoint remains historical. [Security boundaries](architecture/security.md), [setup rehearsal](runbooks/setup-rehearsal.md) and [demo](runbooks/demo.md) are maintained procedures. Native push enrollment/provider/display, hosted Linux, manual accessibility/device and production acceptance remain open. Full Phase 09 and production readiness remain unverified; no public deployment was performed.
