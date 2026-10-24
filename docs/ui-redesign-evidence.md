# Messaging UI redesign — 2026-10-24

## Architecture and scope

The visual reference is Telegram Web's full-height messaging workspace, compact navigation, circular avatars, message bubbles and chat backgrounds. Commonroom retains its own name, original icon/pattern assets and existing email authentication. No Telegram account integration, copied user content, fake conversations or unimplemented Telegram features were added. Reference entry points: [Telegram's official web applications](https://telegram.org/apps?filter=web) and [chat background overview](https://telegram.org/blog/animated-backgrounds).

`apps/web/src/telegram.css` owns the shared light/dark tokens, native controls, responsive chat workspace, settings and authentication surfaces. `styles.css` imports it. `ui.tsx` provides a small original SVG icon set and a theme switch. Only the validated light/dark value under `commonroom:appearance:v1` is persisted, with a storage-denial fallback. Credentials and private content are not written to localStorage. A browser reload/only-preference-key assertion passed.

The chat sidebar contains real inbox rows, all/unread filters, username discovery, a new-group flow, existing invitations and blocking controls. Desktop uses independently scrolling sidebar/history/details; mobile uses one pane with a back-to-chats action and a full-width details panel. Existing backend authorization and replay remain authoritative. Account/privacy, avatars, sessions, recovery, notifications, moderation and deletion remain real existing flows.

The composer provides real emoji text insertion, Enter to send / Shift+Enter newline, IME-aware key handling, reply cancellation and an attachment popover using the original scanner/upload/grant pipeline. Pending-command persistence and idempotency are retained. Message bubble alignment follows the authenticated sender; receipts and timestamps use actual history data. Call buttons retain the real SDK path. The background pattern and favicon are original SVG assets; no external fonts or new runtime package is required.

## Verification plan

1. Build the web workspace; full workspace/tools typecheck and lint/import boundaries.
2. Execute the new independent-user UI gate: keyboard send, emoji, attachment visibility/Escape, light/dark axe scans, inbox filters, details and desktop/mobile navigation. Inspect actual screenshots.
3. Execute existing accessibility, authentication, conversation, messaging, synchronization, attachments/avatar/safety and normal calling gates affected by the shared UI.
4. Execute the integrated journey with real scanner, files, avatars, permissions/moderation and generated audio/video/screenshare. Retain failures and verify any corrections with affected checks.
5. Verify ordinary accounts/migration markers and ownership cleanup, then restore the local app and inspect its actual login/account/chat presentation. Record exact passed/failed/unexecuted gates below; no blanket verification claim.

Existing browser scripts are updated to enter the actual new-message/new-group/attachment/details controls. Their data, authorization, privacy, replay, media and cleanup assertions remain in place. No deadline increase or automatic retry is introduced for the redesign.

## Execution status

**Local redesign gates passed.** The full sequential browser run completed all 12 commands with **27 passing cases**, no automatic retries and no skipped gate: `.cache/browser-gates-ba6bf3a7-c6c0-4951-a0f4-85c46178a3ed/results.json`. Final review subsequently corrected keyboard focus restoration and the low-opacity call-history presentation. The affected UI and normal calling cases were verified again on final source, followed by the separate forced-relay variant. Repeated cases count once.

| Gate | Distinct passing cases | Evidence |
| --- | ---: | --- |
| New UI interactions | 1 | Final `ui-review.log`, 31.1s; focus, keyboard reply/send/newline, emoji, attachment/Escape, filters, persisted theme, 390px navigation and 320px details/block access |
| Existing accessibility | 4 | Full run; rendered auth/account/public/group/error/recovery, keyboard and 320/390/1280px layout |
| Integrated journey | 1 | Full run, 132.154s CLI; actual offline/reload recovery, scanned bytes, avatar privacy, group/moderation/deletion and generated audio/video/screenshare |
| Auth / conversations / messaging / synchronization | 2 / 1 / 1 / 6 | Full run; session/cookie/privacy and actual durable/live/replay invariants retained |
| Attachments / avatars / safety | 1 / 1 / 4 | Full run; real scanner/object bytes, private grants, moderation and deletion |
| Normal calling | 3 | Final `calls-review.log`, 1.1m; independent users, mobile-inbox incoming/accept, devices, screen share, real signed webhooks, group removal, native camera denial, history and terminal-panel close |
| Forced TURN calling | 1 | Final `relay-review.log`, 37.1s; retains relay-selected candidates, media growth, signed webhooks and rejoin/end |
| Interrupted media/upgrade browser cases | 2 | Full run; actual release overlap/rejoin and delayed camera publication |
| Unit / setup guards / lifecycle | 42 / 4 / 1 | `unit-complete.log`, `guards.log`, `lifecycle.log` |

This is **75 distinct passing checks: 28 browser cases (including the relay variant), 42 unit cases, 4 setup guards and 1 actual lifecycle case**. The complete browser run predates the small final focus/history review; the affected final-source checks above passed separately. This is not a rerun of every earlier phase backend/failure/load gate. Full workspace/tools typecheck, lint/import boundaries and workspace/web build passed. The existing large media chunk warning is retained; no warning threshold or browser/provider/production timeout was raised. New UI coverage is included in the consolidated browser command and CI workflow; no hosted run is claimed.

Final private logs: `.cache/ui-redesign/`. Screenshots inspected include actual light/dark/mobile conversations, 320px details, normal calling and the restored live login page. The new fields use real fixtures, not product-seeded fake content. Axe summaries keep incomplete/manual rules, including live-video and SVG/gradient contrast review, rather than suppressing them. Zero automated violations is not full WCAG/native assistive-technology or hardware certification.

## Retained failures and corrections

- Initial keyboard send testing exposed a changing textarea accessible name. The explicit stable `Message` label fixes repeated keyboard targeting; Enter/Shift+Enter and keyboard reply were exercised afterward.
- Initial light/settings/mobile action contrast failures were corrected using a darker accent, fully opaque selected-row/mobile action text and removal of the message-text opacity fade. One unchanged diagnostic group rerun passed before the final action-style cleanup; its intermittent transition timing is not presented as conclusively diagnosed. Final light/dark/mobile/details and account/group scans passed without dropping rules.
- The mobile details panel initially retained a desktop grid placement, so its close button was off-screen/intercepted. Resetting its absolute grid area fixed actual open/close and narrow-width block access. Invisible desktop action hitboxes were removed; actions are exposed by actual hover or keyboard row focus, with tests following those interactions.
- A separate local project took port 3000 during testing. It was inspected and preserved. Tests moved to the existing guarded isolated ports 3010/3011/3012/5180 with a recorded owner. The interrupted fixture was cleaned only after its exact owner, two synthetic users and stopped Commonroom processes were checked. No unfamiliar namespace or process was deleted.
- Isolated upload initially failed with an interrupted transfer. Inspection found the quarantine bucket still allowed `http://localhost:5173` while the test browser used port 5180. Fixture configuration now derives the actual guarded browser origin; the real scanned upload/download and avatar journey passed afterward. Auth links, permission origins, metrics probes and callbacks also use the configured test endpoints. Ordinary test defaults are retained. The lifecycle integration test now binds its configured endpoint and passed its real ownership/live-listener/canary cleanup checks.
- Two unsuccessful runs retained a Mongo cleanup timeout. Server diagnostics recorded `MaxTimeMSExpired`, 5,068ms total, including 4,501,077µs waiting for a database-exclusive lock. The holding writer was not isolated. Exact retained fixture owners were inspected and cleaned with the same existing limits after writers stopped. The subsequent complete run and final focused checks cleaned successfully. No production timeout, browser deadline or automatic cleanup retry was added; the earlier failures remain valid evidence.
- The sync case initially used the old always-visible Account link. Its entry step now opens the actual menu; all six original synchronization assertions passed. Other existing scripts enter the actual new-group/attachment/hover/details controls while retaining their privacy, data, media and cleanup checks.
- The ad hoc local startup initially hit a Windows PowerShell `Split` overload error. Its owned provider cleaned itself up. The helper now uses PowerShell's bounded split and waits for matching provider-ready metadata; the retry started all five recorded processes and passed the live smoke. This helper correction is outside the browser case count.

## Preservation and running application

The baseline captured **3 ordinary users and 9 migration markers** after the user's registration. Before restoring the app, their full recorded fingerprints matched and **zero browser fixture databases** remained. Original data was not reset to the earlier two-user checkpoint. Original dependency containers and the original SFU were preserved. No dependency/lockfile, applied migration or implementation-brief change; no commit, push or deployment.

The redesigned app is intentionally running at **http://localhost:5173**. API/gateway/worker use loopback 3010/3011/3012 to preserve the other project's port 3000. All backend readiness endpoints and the actual login page returned 200; the new SVG favicon returned 200. Real Chromium found the login fields/heading, **zero page errors**, no mobile horizontal overflow, and the expected font. Private result: `.cache/ui-redesign/live-smoke.json`.

Calling is enabled through a separate owned, label-checked loopback media/mail fixture with its callback targeting 3010; the app still uses the existing ordinary SMTP/Mailpit service. Its RoomService health passed. Push remains disabled. Quarantine CORS was explicitly restored and read back against the normal app origin, port 5173. The two intentional live provider containers are development resources, not abandoned browser-test fixtures.

Exact PID/start-time records: `.cache/ui-redesign/live-processes.json`; provider ownership/state: `live-provider.json`. Private generated keys live only in ignored `live-runtime.env` and the owned provider configuration. Do not publish those files. Current operational helpers are `.cache/ui-redesign/start-local.ps1` and `stop-local.ps1`; stop verifies executable/start-time identities, stops only recorded app roles and asks the provider to remove only its labelled resources. The final normal stop helper was written but intentionally not executed against the running app. Stop these owned roles before browser tests need their ports; never stop the unrelated project or sweep containers by prefix.

Native push, hosted Linux/default callback behavior, actual assistive technologies/physical devices/other browsers and production validation remain open as recorded in [the prior local execution evidence](phase-09-local-run-evidence.md). This redesign does not certify those environments or remove the earlier reliability/load-censoring limitations.
