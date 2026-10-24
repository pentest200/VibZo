# UI and accessibility validation

Use the [feature matrix](../phase-09-feature-audit.md) and [09B evidence](../phase-09b-evidence.md) for current executed versus unverified coverage. Automated checks and generated media do not establish full WCAG conformance, screen-reader certification, hardware coverage or production network behavior.

## Navigation and controls

The first keyboard link skips the header to the main content. Client-side route changes focus that main landmark and update the document title; initial page load keeps the normal keyboard entry point. Chat also provides **Skip to conversation** to bypass contacts/navigation, including the mobile layout. Tab order follows the DOM; native buttons, forms, details and browser confirmation/edit dialogs retain keyboard semantics. Status and error feedback use status/alert roles. Reduced-motion preferences disable authored animation/transition and smooth scrolling.

Profile/avatar/deletion/report forms remain distinct. Uploading does not publish an avatar; explicit selection and contextual sharing are required. Native device permission prompts are controlled by the browser, with listener/error/retry fallbacks. Notification unavailability/denial keeps unread discovery available. See [avatars](avatars.md), [calls](calls.md) and [safety](safety.md) for policy.

## Local checks

Use supported Node/pnpm, frozen installation and `pnpm build` first. Baseline/scanner services and Chromium must be available. Stop ordinary dev API/gateway/worker/web before testing; ports 3000/3001/3002/5173 are reserved by the runner. Keep built application files stable while tests run. Retain the configured ownership/post-server cleanup reporter.

```text
pnpm test:a11y
pnpm test:e2e:journey
pnpm test:e2e
```

`test:a11y` runs real rendered public/auth/token/account/chat scans with pinned axe 4.14.0 WCAG A/AA/best-practice rules, keyboard focus/skip/error/recovery and 1280/390/320px reflow. Its 640px viewport is a CSS-layout equivalent for 200% zoom on a 1280px display, not a physical browser/OS zoom certification. Review incomplete/manual rules separately. Live captions, actual assistive technologies, high-contrast OS settings, other browsers, hardware and every device permission state require additional review.

Compact bounded rule/selector summaries persist in `.cache/a11y-results/` and `.cache/journey-results/`, including passing scans. The active-call scan can return a manual `video-caption` result for real-time streams. The application supplies no prerecorded media player and implements no caption/transcription service. W3C distinguishes [two-way conversational calls from broadcasts](https://www.w3.org/WAI/WCAG22/Understanding/captions-live.html); review actual content and user needs rather than treating this manual result as either a captioning pass or an automatic prerecorded-content failure. Do not suppress the rule or claim full conformance from the automated result.

`test:e2e:journey` provisions a fresh loopback-only owned real SFU/mail fixture with runtime-only credentials, runs independent verified users across chat/offline/reload/files/avatar/privacy/reporting/group authority and actual generated WebRTC media, then removes only that fixture. It does not use the original development SFU webhook route and does not certify Linux browser webhook routing or forced TURN. The existing ordinary call browser suite still requires the configured original provider and working host callback route.

`test:e2e` runs the interface gate, a11y, the integrated journey, all individual browser regressions and the isolated killed-SFU/rejoin drill **sequentially**. Each command gets a bounded private log and results/current-step files under a fresh ignored `.cache/browser-gates-<uuid>/`. It stops on the first nonzero CLI result, with no automatic retries. Use `pnpm test:e2e <first-gate-name>` to resume only after reviewing the failure and ownership-checked cleanup; this executes a suffix, not a full passing gate. Do not count repeated checks twice. Per-command limits are 15 minutes and 8 MiB output; a limit or outer hard kill can require manual fixture ownership inspection. Never drop an unknown database/container by prefix alone.

The Telegram-style redesign and its latest executed checks are recorded in [UI evidence](../ui-redesign-evidence.md). Ordinary calls retain the configured provider by default; guarded isolated-port runs use an owned provider with the matching callback origin.

The separate `test:e2e:calls:relay` gate is deliberately excluded from that consolidated target while its known restrictive-network acceptance remains open. Native positive push/provider display also remains separate. Normal calls transport real generated media, not hardware devices.

## Review procedure

Inspect actual desktop/mobile captures and use Tab/Shift+Tab/Enter/Space through navigation, disclosure and form states. Check focus visibility/order, responsive reflow, labels, status/error recovery, contrast and native confirmation cancellation. Include empty, unverified, unavailable, denied, removed and expired states rather than scanning only a happy-path page. Keep any untested branch explicit in the feature matrix. Avoid logging DOM/message content, bearer URLs, media SDP/device IDs or tokens in audit summaries. Private synthetic failure artifacts remain ignored.
