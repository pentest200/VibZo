# Chat interaction improvements - 2026-10-24

Completed report/layout fixes, composer editing, full-screen calls with a persistent compact view, independently scrolling conversations, private in-app media playback, clear history, delete direct chat and owner-only delete group. This locally verified follow-up does not claim Telegram feature parity or production certification.

## Architecture and behavior

Native top-layer dialogs contain reports and management confirmations, restore focus, and support Escape. Message action menus wrap inside the bubble. Sidebar, history and details scroll independently. Editing uses the composer and existing durable command engine with expected message version; save/cancel/Escape preserve the previous unsent draft and selected files.

One mounted call/media session switches between full-screen modal and compact nonmodal views. Back/Escape minimizes it below the chat header; Expand restores it. Real tracks continue while chatting. Device, screen sharing, acceptance, leave/end, error and native permission controls retain server/SDK authority. Credential pacing now rechecks the permitted deadline after waiting so a slow previous response cannot trigger an early request.

Authenticated, CSRF-protected preview grants retain download visibility and ready-object checks. Inline disposition is limited to fixed image/audio/video MIME types; documents retain forced download. URLs remain memory-only, private/no-store and short-lived. Closing/revocation/unmount stops playback. GIF/MP4/WebM/MP3/WAV/Ogg join the existing allowlist with bounded size/checksum/signature checks, private quarantine and real ClamAV. Original photos retain isolated decoding/re-encoding. GIF block parsing bounds dimensions, frames and total pixels and rejects trailing bytes. Browser codec support still applies.

Additive `010_chat_experience` preserves prior validators/records and adds optional membership hiding, explicit group-deletion state and media kinds. Applied 001-009 migrations are unchanged. New management/media admission requires 010. Upgrade API/worker/gateway/web together before enabling new contract kinds; historical overlap drills do not certify old binaries serving them.

Guarded, idempotent management transactions clear only the caller's visibility and invalidate pinned snapshots. Direct deletion also hides its membership from normal/snapshot inboxes; a new accepted message or explicit reopening restores it. Receipts/control events do not. Clear/direct delete require leaving an accepted open call first. Owner-only group deletion archives the group, revokes active/invited membership and history/file/call access, and wakes fenced SFU cleanup. Safety maintenance serializes on the group and drains at most 10 messages and 20 additional files per transaction. Bodies become tombstones through existing events/outbox; files enter existing cleanup/grant grace. `historyPurgedAt` marks redaction/cleanup admission, not erasure of every copy. Old archived groups without explicit requests are excluded.

Encrypted restore accepts exact known marker prefixes through 010. Current clear windows and hidden memberships remain restrictive; explicit current group deletion scrubs snapshot bodies/files even if source cleanup has not drained. Restoring new negative policy through an 008/009 snapshot fails before target claim. Genuine compatible historical snapshots remain supported.

## Ordered acceptance work

1. Contained dialogs, independent panes and composer edit/draft restoration: implemented and exercised in UI, keyboard, synchronization and accessibility gates.
2. Full/compact calls without replacing mounted media: implemented; actual generated frames/audio continue while minimized, expansion adds no peer connection, and group removal/device denial/rejoin/strict relay pass.
3. Private media and clear/delete authority: implemented; actual Mongo/HTTP/storage/scanner/provider and browser history/permission checks pass.
4. Build/types/lint, units and affected regressions plus screenshot inspection: completed within the recorded scope below.
5. Preserve original records, apply 010 twice, restore upload origin and restart: completed; live health/browser/provider checks pass.

## Executed verification

**195 distinct passing automated cases.** Repeated runs count once. These staged checks include focused reruns after fixes; they are not one uninterrupted full-suite run or a rerun of every historical phase.

| Gate | Passing cases | Evidence |
| --- | ---: | --- |
| Unit | 50 | `unit-final.log` |
| Conversations integration | 19 | `test-integration-conversations-final.log` |
| Attachments integration | 17 | `test-integration-attachments-final.log` |
| Synchronization integration | 13 | `test-integration-sync-corrected.log` |
| Actual-provider calls integration | 14 | `test-integration-calls-verified.log` |
| Safety integration | 19 | `test-integration-safety-final.log` |
| Avatars integration | 10 | `test-integration-avatars-verified.log` |
| Actual encrypted backup/restore | 18 | `test-restore-verified.log` |
| Setup policy guards | 4 | `test-setup-guards-verified.log` |
| UI/accessibility/journey/auth/conversations/messaging/sync/files/avatars/safety browsers | 25 | Browser records below |
| Final normal calling browsers | 3 | `test-e2e-calls-verified.log` (1.2m) |
| Final killed-provider/delayed-track browsers | 2 | `test-e2e-upgrade-verified.log` (57.8s) |
| Final strict TURN browser | 1 | `test-e2e-calls-relay-verified.log` (37.7s) |

Bare log names are under ignored `.cache/experience/`. Browser records: `.cache/browser-gates-c7da6fd8-282f-42f3-b107-8c4f2c045ab8/results.json` contains UI 3/accessibility 4 plus the first failed journey. `.cache/browser-gates-6f74b19a-6f7e-4e9e-8722-ea613d709aa1/results.json` contains corrected journey 1/auth 2/conversations 1/messaging 1/sync 6/attachments 2/avatars 1/safety 4. Its earlier call results are superseded by final focused logs above, not added again.

Workspace build, workspace/tools typechecks and lint/import boundaries passed. The final domain call guard was rebuilt and exercised by final call integration. Final restore covers recovery changes; final types/lint passed. Full fresh setup, operational dependency failure and load trials were not repeated for this request.

Actual scanner/storage-backed browser playback covers photo WebP, GIF, WAV, WebM and MP4 on desktop/mobile. MP3/Ogg support is implemented, but separate native MP3/Ogg playback was not executed. Keyboard/focus/axe includes six report layouts (light/dark at desktop/390px/320px); native assistive technology is separate.

Visually inspected `.cache/qa/` artifacts: `report-light-320.png`, `scrollable-conversations.png`, `media-clip-mp4-390.png`, `media-tone-wav-390.png`, `media-photo-webp-1280.png`, `call-minimized.png`, `calls-desktop.png`, final two-column `calls-mobile.png`, and refreshed live login screenshots. Mobile call controls remain in a scrollable full-screen surface.

## Retained failures and corrections

- Initial GIF header/trailer validation admitted crafted trailing data. ClamAV did not flag that embedded EICAR sequence; bounded structural parsing now rejects it. Existing standalone EICAR still passes. Antivirus is not proof that all content is harmless.
- Initial UI expectations omitted a deliberate trailing newline, a report field needed a stable accessible label, and a test captured its URL before navigation. Labeling and exact draft/navigation assertions were corrected. The old journey tried using background UI through the new modal; it now closes ended call panels before continuing.
- Actual provider recovery exposed the slow-response credential pacing race described above. Deterministic regression and unchanged real-provider recovery now pass. A group-call test rang before the final invitation acceptance committed; it now waits for the authorized group view. Final calling passes.
- Recovery/setup tools initially expected nine markers; exact prefix handling and actual 010 negative-policy restore now pass. Type review corrected stale compiled declarations and Mongo/browser/provider narrowing.

First-run results remain in `.cache/experience/` (`ui-first-results`, `journey-first-results`, `calls-first-final-results`, `upgrade-first-results` and earlier logs). No assertion was removed; no automatic retry, test/provider timeout or production cooldown was increased. Intentional process-fault socket-reset output remains with actual results.

## Preservation and running app

Before restarting, captured original fingerprints matched: **3 users, 1 conversation, 1 membership and 2 messages**, plus all original nine marker records. Migration 010 applied twice; the four data fingerprints and old markers still matched, with ten total markers. `.cache/experience/preservation.json` and `preservation-current.json` retain the baseline/result. No ordinary password/data reset occurred. Later legitimate user/worker activity must not be rolled back to these hashes.

Only the requested media allowlist was updated in ignored local `.env`. Quarantine PUT CORS was restored/read back to `http://localhost:5173`. The app is intentionally running there with private API/gateway/worker **3010/3011/3012**. All readiness endpoints return 200 with matching roles; real Chromium login/favicon return 200, zero page errors and no 390px overflow. Private media is healthy, calls enabled, push disabled, storage origin matched and no open media rooms remained. Final fixture-database inspection is recorded in `.cache/experience/live-health.json`; browser result is `.cache/ui-redesign/live-smoke.json`.

Current exact process/start-time and provider-owner records: `.cache/ui-redesign/live-processes.json` and `live-provider.json`. Its start/stop helpers use explicit env files and ownership checks. The intentional owned media/mail pair routes callbacks to 3010; original infrastructure/SFU, SMTP/Mailpit and the other project's port 3000 listener were preserved. Private runtime provider settings stay ignored. No dependency/lockfile change, commit, push or deployment occurred.

## Exact resume tasks and remaining boundaries

No implementation/local acceptance step from this UI request remains pending. Preserve changes and keep the app running. Before conflicting tests, read current process/owner records, stop only recorded roles with `.cache/ui-redesign/stop-local.ps1`, restore normal upload CORS afterward and restart with `start-local.ps1`. Never use obsolete PIDs or clean by name prefix. Further interface feedback is new work.

Existing external gates remain: compatible native push/provider/display/full-account checks; authorized hosted Linux CI/webhook/signal evidence; native assistive technologies/OS zoom/high contrast; physical hardware/other-browser/codecs; production TLS/IAM/rotation/HA/orchestrator/independent-host/PITR/regional recovery/capacity. Earlier intermittent 503 uncertainty and generator-censored load profiles remain disclosed in Phase 09. Local passes do not close these gates or create another numbered phase.

References: native [dialog](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog), [audio](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/audio), [video](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video) and [Content-Disposition](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Disposition). See the [interaction guide](runbooks/interface.md).
