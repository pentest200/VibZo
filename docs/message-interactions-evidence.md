# Message/chat interaction follow-up - 2026-10-24

Scope: app delete-choice dialog, inline photos/video/audio, private chat pins/archive, shared message pins, automatic read receipts/ticks, resizable conversation sidebar and full emoji picker.

## Architecture and ordered implementation

1. Add `011_chat_interactions` without editing applied migrations. Extend prior validators with optional membership `pinned`/`archived` and message `hiddenFor`/`pinned`, plus an index for conversation pins.
2. Reuse guarded transactions and stable command IDs. Personal deletion excludes content from normal/snapshot/pinned history, unread counts, replies/mutations and new file grants; other participants' bodies/files remain. Captured private views are invalidated. Global deletion retains sender/version checks and existing tombstone/file cleanup. Group pins require admin/owner; direct participants can pin. Bounds: 10 pinned chats/account, 50 shared pins/chat. Direct-chat deletion clears its preferences. Archive remains private until explicitly unarchived; it does not leave/block/erase the chat.
3. Extend exact encrypted recovery marker support through 011. Current personal hiding is unioned with snapshot hiding; current pin/archive state applies, including later unpins. New negative personal policy is refused on pre-011 snapshots before target claim. Compatible older snapshots remain supported.
4. Replace native browser confirmation with a top-layer app dialog. Own messages offer Delete for me / Delete for everyone / Cancel; received messages offer personal deletion. Message operations retain the durable queue; private chat writes retain IDs for uncertain retries and refresh authoritative inbox/detail.
5. Load private media near the viewport directly in bubbles. Coalesce in-flight requests per account/session/file; limit concurrent grants to three. Images expand; video/audio have native inline controls, optional expansion/download and no autoplay. Grants remain memory-only, short-lived, authenticated/CSRF-protected. Loading/fresh-grant retry/unsupported-codec/revoked-access states remain visible. Expanding pauses inline playback; closing destroys the expanded player.
6. Advance delivery for latest recovered history, but reading only for sufficiently visible messages in the active, focused/visible document, without a modal and with a successful hit test. Intersection/scroll/focus/visibility events schedule bounded durable monotonic receipts. Single tick: server accepted; double: delivered; blue double: read. Group status means at least one eligible peer. Remove the manual mark-read button.
7. Add bounded 260-520px pointer/keyboard separator (arrows/Home/End, double-click reset), reserving main-pane space and retaining mobile single-pane behavior. Persist only validated non-sensitive width. Lazy local Unicode 17.0 catalogue contains 3,953 qualified sequences/components with categories/search/skin tones, incremental rendering and exact cursor insertion. Native emoji glyph/artwork support varies by OS; no proprietary Telegram/WhatsApp assets or stickers are included.

## Executed verification

**190 distinct passing cases** in this staged affected set: 50 units, 114 integrations, 4 setup guards and 22 browsers. Focused reruns count once. This is not one uninterrupted full-suite pass, nor a rerun of every earlier phase/load/full-setup gate.

| Gate | Cases | Ignored evidence under `.cache/telegram-interactions/` |
| --- | ---: | --- |
| Unit | 50 | `test-first.log` |
| Sync integration | 16 | `test-integration-sync-verified.log` |
| Conversation integration | 19 | `test-integration-conversations-verified.log` |
| Real scanner/storage attachments | 18 | `test-integration-attachments-first.log` |
| Actual encrypted restore | 18 | `test-restore-first.log` |
| Safety | 19 | `test-integration-safety-verified.log` |
| Avatars | 10 | `test-integration-avatars-verified.log` |
| Actual provider calls | 14 | `test-integration-calls-verified.log` |
| Setup guards | 4 | `test-setup-guards-verified.log` |
| UI | 5 | `test-e2e-ui-verified.log`; final extended cases below |
| Accessibility | 4 | `test-a11y-verified.log` |
| Files browsers | 2 | `test-e2e-attachments-corrected.log`; final containment below |
| Sync browsers | 6 | `test-e2e-sync-corrected.log` |
| Integrated journey | 1 | `test-e2e-journey-final.log` |
| Conversation browsers | 1 | `test-e2e-conversations-final.log` |
| Normal generated-media browsers | 3 | `test-e2e-calls-final.log` |

Final extended UI checks: `reads-final.log` passed the real covering-dialog and below-viewport unread controls, followed by automatic reading when uncovered/scrolled into view. `emoji-send-final.log` passed family/skin-tone insertion, actual peer delivery and persistence after reload, along with deletion/pin/archive/splitter coverage. `inline-layout-corrected.log` passed real private photo WebP/GIF/WAV/WebM/MP4 inline and expanded rendering/playback at desktop/390px, including strict card-within-bubble bounds. These replace the corresponding earlier cases; they are not extra totals. MP3/Ogg are supported but separate native MP3/Ogg playback was not executed. Native OS focus/artwork/hardware/other-browser behavior is outside headless Chromium coverage.

Full workspace build, workspace/tools types and lint/import boundaries passed (`build-final.log`, `types-final.log`, `lint-final.log`). Final CSS has its own successful web build (`web-final.log`); later test-only extensions have focused tools-type/lint logs. Final preference cleanup was rebuilt and exercised by sync/conversation integrations. No dependency/lockfile change or prior migration edit.

## Retained failures and corrections

- First lint required explicit Node imports in the generator; corrected without rule changes. Initial official emoji URL was absent; the pinned Unicode release directory succeeded.
- A first headless test assumed `bringToFront` yields mutually exclusive OS focus across independent contexts; both reported focus and the recipient read immediately. Production focus/visibility checks remain. A real modal and actual scrolling now provide observed blocked/off-screen reading controls. First UI run: four passed, focus control failed; retained in `ui-first-results/`.
- First media run expected the old visible filename text after the UI intentionally replaced it with direct media/icon controls. The assertion now checks the actual accessible attachment control. Playback remained tested. Retained in `media-first-results/`.
- Screenshot review and a stricter boundary assertion caught a real mobile grid minimum-width overflow. Explicit zero-minimum grid tracks/children contain media; image button padding is also scoped. Final containment/playback passed; failing artifacts remain in `media-containment-first-results/`. The assertion was retained.
- First journey user assertions passed, but the exact-owner database drop exceeded the existing five-second Mongo limit. Original log/result remain. After checking the exact run marker, removed owned provider, closed listeners and empty storage prefix, database-only completion succeeded under the same driver budget (`journey-cleanup.json`). One unchanged diagnostic journey repeat passed with cleanup. No causal fix for the intermittent Mongo cleanup delay is claimed.

No focus/permission JavaScript stubs, automatic retries, increased existing deadlines or removed acceptance assertions. Expected socket-reset/SDK teardown warnings are retained with actual results.

Visual review: contained `delete-message-choices.png`, `emoji-picker-mobile.png`, final `inline-photo-webp-390.png`, `inline-tone-wav-390.png`, `inline-clip-mp4-390.png` and `automatic-read-ticks.png` under `.cache/qa/`. The media fixtures are synthetic generated content; no product conversations were seeded. Pointer/keyboard resizing and persistence are asserted by the real UI test.

## Preservation and restoration

The checked app/provider stop preceded a fresh baseline in `.cache/telegram-interactions/preservation.json`. Original counts/fingerprints matched: **3 users, 1 conversation, 1 membership, 3 messages and ten marker records**. Additive 011 applied twice; the same four data fingerprints and original ten marker records still matched, with eleven markers total (`preservation-current.json`). No original account/password/data reset. Later legitimate user/worker activity must never be rolled back to historical hashes.

Normal quarantine PUT CORS was restored/read back to `http://localhost:5173`. The app is intentionally running there, with API/gateway/worker on loopback **3010/3011/3012**. Each readiness endpoint returned 200 and its matching role; real Chromium login/favicon returned 200, zero page errors and no 390px horizontal overflow. Private media RoomService is healthy, calls enabled, push disabled, storage origin matched, zero open owned rooms and zero fixture databases. Results are `live-smoke.json` and `live-health.json` under `.cache/telegram-interactions/`. Native login screenshots were refreshed. Original dependencies/SFU/SMTP/Mailpit and the unrelated port 3000 project were preserved.

Current exact PID/start-time/owner records are `.cache/ui-redesign/live-processes.json` and `live-provider.json`. The deliberately running labelled media/mail pair provides callbacks to 3010; it is not a stale test fixture. Private runtime keys remain ignored. No commit, push or deployment.

## Exact resume state

No implementation/local acceptance step from this request remains pending. Preserve all source/docs/tests and the intentionally running app. Before port-conflicting tests, inspect current process/provider records, use only the path/start-time/owner-checked `.cache/ui-redesign/stop-local.ps1`, restore normal upload CORS after fixtures, and restart with `start-local.ps1`. Never reuse obsolete process IDs, clean by namespace prefix, or roll back legitimate user activity. All verification sessions have exited; intentionally launched app/provider roles remain running. Further interface feedback is new work.

External gates remain native push/provider/display, hosted Linux CI/platform signals, native assistive technologies/physical devices/other browsers/codecs and production infrastructure/recovery/capacity. Local generated Chromium checks do not certify them.

Sources: [pinned Unicode data](https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt), [Unicode license](https://www.unicode.org/license.txt), [intersection observation](https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API). Derived catalogue/license: `apps/web/src/emoji/`; `public/emoji-license.txt` is also copied into production web output. Regenerate with `node scripts/generate-emoji.mjs <downloaded pinned input>`.
