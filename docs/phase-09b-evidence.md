# Phase 09B UX, accessibility and integrated feature audit - 2026-10-20

Status: **B1-B4 locally verified within the executed automation/keyboard/reflow scope; manual assistive-technology and media boundaries remain below**. Historical execution notes are superseded by the final checkpoint.  Entry `2f354f7` with uncommitted 09A preserved. Current two-user/nine-marker fingerprints and all 40 original ordinary collections match the A checkpoint; no fixture databases or provider rooms. Original dependencies are healthy and authenticated LiveKit available. Applied 001-009 and original mail/data must remain intact.

Design and ordered gates are in the latest [plan](../implementation_plan.md). Before implementation: account CTA/paragraph overlap at desktop/mobile, no skip navigation or SPA route focus management, and earlier group-call timeout/Chromium VP8 collision remain recorded findings. The latter is not established as a product bug or resolved by the most recent passing rerun.

Use pinned dev-only axe + actual Playwright for rendered A/AA checks, plus keyboard/focus/reflow/error and integrated multi-user behavior. [Playwright accessibility guidance](https://github.com/microsoft/playwright/blob/main/docs/src/accessibility-testing-js.md) and [axe source](https://github.com/dequelabs/axe-core) describe the automation boundary; [W3C navigation criteria](https://www.w3.org/WAI/WCAG22/Understanding/navigable) inform focus/skip review. Automated passes do not establish full WCAG conformance, screen-reader support or every media/hardware/browser path.

Executed results, failures, exact owned fixture identities, cleanup and remaining tasks will be recorded below. No 09B gate is marked verified yet.

Owned SMTP receiver: `commonroom-phase09b-mail-7d6e2c91`, label `commonroom.fixture=phase09b-7d6e2c91`, full ID `fe7f073558e8b015695d39c66be999b5d31f772734d55885e3813306b2bb42e7`, loopback 1026/8026, pinned Mailpit with RDNS disabled and bounded resources. Original receiver/mail untouched. Ignored result journal and bounded logs: `.cache/phase09b-7d6e2c91/`.

Pinned `@axe-core/playwright`/`axe-core` 4.14.0 through normal pnpm policy. Lock review found only these new package versions; pnpm also coalesced the existing Vite 8.3.4 optional-yaml peer variant onto the already pinned yaml 2.9.1 variant. No production dependency version/image/migration changed. Existing pnpm update notice was not acted on.

Initial build/typecheck passed. First actual a11y command failed all three cases on brand `label-content-name-mismatch` (33.635s): decorative visible `c.` was absent from its override. Corrected the full visible label/name. Next run passed public/account, failed the chat fixture's exact label-text lookup (46.324s): nested select option text made `getByLabel(... exact)` differ from its actual accessible name. Switched to the actual named combobox; no rule/assertion was disabled. Both failure artifacts were copied privately before reuse. Added stronger input/textarea borders from manual contrast review; full final stable rerun remains required.

Implemented layout/landmarks, skip navigation and route focus/title, CTA reflow and reduced-motion policy; added three a11y cases, one integrated real-service journey and a sequential bounded browser orchestrator. Added counter-only connected-media snapshots/cleanup milestones to the existing group call case without changing its 120s budget or assertions. Latest build/typecheck/lint, then a11y/journey are queued in session **45781**. Earlier 70823/39678 have exited. Do not modify/rebuild web sources during active browsers. No final success claim yet.

45781 stopped at lint's control-character regex rule in the new log parser, before browsers. Replaced custom ANSI parsing with Node's standard `stripVTControlCharacters`; lint passed. Next audit (session 94744, 42.949s) again passed public/account and uncovered two actual selected-chat violations: an ARIA label on a generic avatar container, and small inbox text contrast against the selected background. Added the appropriate group role and darkened the small text. No axe rule was disabled. All three failed audit attempts/artifacts are retained. The integrated journey now uses its own label-checked real SFU/mail fixture lifecycle, avoiding reliance on the original host webhook route; it does not prove that separate Linux routing gate.

After those fixes, a11y **3 passed / 48.522s**. Reviewed actual 390px account and 1280px group captures: CTA is clear, report select/focus and full form layout visible. Manual computed contrast: input border `#748378`/white **3.992:1**, selected inbox small text `#526158`/`#e7ede2` **5.487:1**, focus `#4d796a`/white **4.931:1**, hint `#59636d`/white **6.122:1**. These checks supplement automated text checks; they are not complete OS/high-contrast certification.

First integrated journey reached real normalized/avatar/file bytes and actual two-user audio/video/screenshare with active-call axe passing; safe peer sample **122 decoded frames / 56,111 audio bytes**. It failed later on a fixture race (**86.804s**): group acceptance navigation was not awaited before a reload, leaving the peer on its old direct route. Added explicit group-route and completed-role-save synchronization, preserving the role/authorization assertions. Failure artifacts copied before reuse; owned provider/mail cleanup completed normally. Added a fourth unverified-account audit and Shift+Tab/Space disclosure checks. Compact axe reports now persist separately in `.cache/a11y-results` / `.cache/journey-results` so later suites cannot erase manual/incomplete review data. No DOM or message bodies are included in those JSON summaries.

Final full browser target is queued after typecheck/lint in **session 70928** (`pnpm test:e2e`). It writes its own fresh `.cache/browser-gates-<uuid>/` current/results/logs; identify that path from session output. App build is stable; no rebuild/source edit under the browser group. Session 74507 has exited. SMTP identity above remains needed. Final affected backend/tooling/preservation and cleanup are pending.

Full target directory: `.cache/browser-gates-ad130414-37e5-45c1-ba8c-a37daf2304d6/`. Final a11y **4 / 53.179s**, integrated journey **1 / 120.209s** and auth **2 / 27.070s** passed. The journey now completes the combined workflow, including actual file equality, offline stable-ID reload, avatar opt-in, real audio/video/screenshare, outsider denial/group role/removal, report/moderator tombstone, block/unblock and actual account deletion. Sample peer counters: 114 decoded frames / 50,877 audio bytes. These small generated-media observations are not load or hardware evidence.

Reviewed compact artifacts: **19 distinct a11y route/state scans, zero violations and zero incomplete rules**. The journey adds **two scans**, zero violations but an actual **`video-caption` incomplete/manual result on active live WebRTC video**. This remains visible: no prerecorded clips are supplied by the application, but live captions/transcription are not implemented and native assistive technologies have not been exercised. No WCAG conformance claim or rule suppression. Captions need their own product/environment review; see [W3C live captions](https://www.w3.org/WAI/WCAG22/Understanding/captions-live.html) and [prerecorded captions](https://www.w3.org/WAI/WCAG22/Understanding/captions-prerecorded.html). Final other browser/affected gates and cleanup remain pending.

The complete final `test:e2e` target exited 0 in session 70928: **25 checks / 11 commands**, no automatic retries, command failures or log/watchdog limit hits. It ended with actual isolated killed-SFU/rejoin **1 / 50.643s**. Full calls **3 / 67.924s** retained the original 120s per-case deadline and all pixel/audio/authorization assertions. Group connected samples for owner/peer/third: **41/36/34 decoded frames**, **14,828/13,030/15,729 audio bytes**, each one connected and zero closed peers at sampling. Both auxiliary context-close milestones completed. Zero VP8 warning occurrences in this log; earlier Phase 08E timeout/collision remains unreproduced and causally unexplained. This single successful diagnostic run is not a reliability rate or a root-cause fix.

Caption manual review: W3C's guidance distinguishes conversational two-way calls from broadcast caption responsibility. Our scoped application provides real-time conversations, no prerecorded player or captions/transcription service. The incomplete prerecorded-video rule is retained as a content/user-needs review boundary, not suppressed or counted as a captioning pass. Other screen-reader/OS/hardware/browser testing remains open. Final affected backend group is now active after the browser process exited; no concurrent heavy test or rebuild.

## Final local verification

**94 distinct checks / 16 commands executed this phase: 69 affected backend/unit/HTTP and 25 browser checks.** This is the affected regression set for UI/test-tool changes, not a rerun of all 222 prior 09A backend checks. Domain/API/schema source from 09A is preserved. There were 21 suite attempts including 4 failed focused attempts recorded above; the final full browser target and affected backend group each passed without a failed command or automatic retry. The separate lint parser failure is also retained above. Repeated/subset cases count once. No watchdog/output limit hit.

### Affected backend

| Command (`pnpm ?`) | Passed | Seconds |
| --- | ---: | ---: |
| `test` | 40 | 2.135 |
| `test:foundation:http` | 3 | 6.344 |
| `test:integration:sync` | 13 | 43.872 |
| `test:integration:calls` | 12 | 37.024 |
| `test:integration:e2e-lifecycle` | 1 | 6.299 |

### Complete browser target

| Command (`pnpm ?`) | Passed | Seconds |
| --- | ---: | ---: |
| `test:a11y` | 4 | 53.179 |
| `test:e2e:journey` | 1 | 120.209 |
| `test:e2e:auth` | 2 | 27.070 |
| `test:e2e:conversations` | 1 | 45.406 |
| `test:e2e:messaging` | 1 | 31.625 |
| `test:e2e:sync` | 6 | 86.277 |
| `test:e2e:attachments` | 1 | 33.317 |
| `test:e2e:avatars` | 1 | 103.083 |
| `test:e2e:safety` | 4 | 50.082 |
| `test:e2e:calls` | 3 | 67.924 |
| `test:e2e:upgrade` | 1 | 50.643 |

Final root build, workspace/tools typecheck, ESLint/import boundaries, normal-policy frozen offline installation, all-profile Compose validation, workspace and processor production audits, browser secret-name scan, Markdown targets and whitespace checks passed. Both audits returned no known production vulnerabilities. The existing >500kB web chunk warning remains. The lockfile change adds exact dev-only axe packages and coalesces an existing Vite peer variant; no production package/image pin changed. CI adds a11y and the isolated journey, but no remote CI run is claimed. The consolidated local target includes ordinary calls; the original Linux browser webhook route remains its separate open environment gate.

## Final preservation and cleanup

Final `.cache/phase09b-preservation.json` exactly matches A for both ordinary users and all nine marker fingerprints, the original eight-marker fingerprint and applied 009 source SHA. All 40 earlier ordinary collection fingerprints match the A baseline. No migration was added or reapplied in B. Original brief and applied 001-008 source have no Git differences; applied 009 remains `be0501e282ff7c5765121ce2a515c3715381044656e8cbfd5f0f17120200ea19`, 008 remains `19F89390A30B85DE42E25BAFD2FD05452FF43B445B2FA382DC6A1953EFE909FB`. Keep 001-009 fixed. No original data, buckets, volumes or mail was cleared.

Zero fixture databases and original-provider rooms remain. Original eight dependencies healthy, authenticated original LiveKit available. Removed the 09B SMTP receiver only after checking its full ID and exact owner label above. The journey and killed-SFU launchers cleaned their own label-checked providers/mail and runtime credential files. No owned upgrade container, telemetry fixture volume/network, generated provider config, agent lock, checked application/proxy/telemetry/mail TCP listener or verification Node process remains. Unrelated containers are retained. All sessions, including 70928 and 75169, have exited; no live fixture is needed to resume. Ignored bounded logs, compact axe summaries and synthetic failure artifacts remain for review.

## Result and remaining scope

B1 control/authority/error matrix, B2 implemented fixes and actual keyboard/reflow/contrast scans, B3 integrated journey/consolidated target and B4 scoped call diagnostics/regressions/preservation are locally complete. Actual fixes: CTA overlap; page landmarks/skip links/route focus and title; brand name matching visible text; avatar group semantics; selected inbox and input contrast; wrapping narrow controls; reduced-motion preference. No scanner, permission, media assertion, existing timeout or API contract was weakened.

There is no claim of full WCAG conformance, native screen-reader/voice-control/braille/OS high-contrast coverage, actual OS zoom certification, every native dialog cancellation/device permission combination, live captions/transcription, hardware or other-browser certification. The active-call `video-caption` manual result remains documented with its conversational-content rationale. The earlier group timeout/VP8 collision remains unreproduced and undiagnosed; the new successful counters/context-close milestones do not close that reliability observation. Native positive push/provider display, forced TURN/Linux browser webhook routing and Linux application signals/orchestrator behavior remain independent gates.

Resume at **09C: bounded disclosed chat/media/combined measurements**, then **09D: isolated clean setup/demo and reconciled final evidence**. Production TLS/IAM/rotation/HA/PITR/regional recovery/key custody/capacity and remote CI remain unverified. Current work preserves uncommitted 09A and adds uncommitted 09B on `2f354f7`; no commit, push, deployment or external-provider send. Exact remaining tasks are in the latest [implementation-plan checkpoint](../implementation_plan.md).
