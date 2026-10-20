# SFU recovery browser CI correction

Status: locally verified; hosted Linux CI rerun pending.

The supplied Linux `test:e2e:upgrade` log reaches its 180-second deadline in `BrowserContext.close`. Chromium also reports VP8 BUNDLE payload 96 with differing `x-google-start-bitrate` parameters. The log does not establish a causal link between the negotiation warnings and the teardown hang. This is separate from the historical dependency preparation correction.

The pinned LiveKit client is 2.23.0. Its default is a single peer connection for publication and subscription. The [official RoomOptions reference](https://docs.livekit.io/reference/client-sdk-js/interfaces/RoomOptions.html#singlePeerConnection) documents opting into separate connections with `singlePeerConnection: false`. The installed SDK's `PCTransport.ts` confirms that the start-bitrate hint modifies video codec parameters and that bundled sections must agree. No SDP rewrite or custom codec is appropriate in application code.

The web client now selects the supported dual-peer mode as a compatibility workaround: publisher and subscriber codec bundles are separate. This adds a second ICE/DTLS transport per participant; it does not change codecs, SDP, simulcast, media thresholds, authorization or admission. This Windows session does not establish the precise cause of the Linux native teardown hang.

Counter-only browser instrumentation counts rejected local and remote descriptions containing codec/payload collisions without saving descriptions, credentials or addresses. The recovery test records aggregate media counters before and after recovery, waits for every observed peer to close and every captured native microphone/camera track to end, then reports context-close milestones. On an assertion failure only, emergency cleanup stops the test's captured tracks and closes its observed peers before context teardown, so an active media session does not mask the original assertion. Passing cases must prove natural SDK release before that cleanup path.

A separate regression receives real remote video before releasing a bounded native-camera capture gate. The gate delays the actual generated-device `getUserMedia` call by at most 60 seconds; it does not supply fake streams, RTP, SDK state or SDP. The test then requires actual camera publication, remote decoded video/audio and full media release. Native denial remains covered by the existing calls suite. Missing remote elements now fail after an explicit 20-second attachment check rather than consuming the whole test deadline in scrolling. Original audio/video thresholds, room rotation, old-room deletion, outsider denial and the 180-second test deadline remain intact. Retained failure traces are private test artifacts, not sanitized public evidence.

## Attempts

- Unchanged product plus recovery diagnostics: Windows Chromium passed one recovery case, 25.6s case / 1.5m command. Zero counted codec collisions and full media release. This does not reproduce the hosted Linux hang.
- Native permission-reset experiment against the old setting: one case hit its 180s deadline. Against dual mode, SFU recovery passed (37.0s) but permission-reset still timed out. Its trace and screenshot show camera capture remained unavailable after the CDP permission change; no codec rejection was established. This experiment was replaced by the bounded capture-latency test, not counted as a product regression fix. Both failed attempts and snapshots/traces are retained privately.
- Dual mode with capture gating: **2 passed / 1.2m**, recovery 34.1s and delayed capture 16.1s. Actual before/rejoin samples each had two connected peers, and all release checks completed.
- Calibration with the previous single-peer setting: delayed capture also passed, **1 / 35.5s command, 17.3s case**. Therefore delayed capture is useful ordering coverage, not a deterministic reproducer of the Linux collision or evidence that the exact native hang cause has been isolated. Dual mode was restored before final checks.
- First final calls command: all **3 cases passed**, including screen share, group removal/rotation and native denial, but the command exited 1 when its cleanup reporter's Mongo database drop exceeded the existing 5s socket deadline (78.719s command). This attempt is failed evidence, not a verified gate. A read-only check found the exact fixture database still present, original users/nine markers unchanged and zero rooms. The existing cleanup helper then removed that exact namespace after checking its recent ownership marker and stopped listeners. No deadline was increased, ordinary data reset or database prefix swept. The original failed command log is retained and the whole affected gate is rerun.

## Final verification

Executed on Windows with workspace Node 24.21.0, pnpm 12.11.2, Playwright 1.64.0 / Chromium revision 1248 (156.0.8078.4), LiveKit client 2.23.0 and the pinned 1.13.9 server. These are generated devices and local Docker services, not hardware or cross-platform certification.

| Check | Result |
| --- | --- |
| Full workspace build | Passed |
| Full workspace/tools typecheck | Passed; latest cleanup-helper tools recheck also passed |
| ESLint and browser import boundaries | Passed; final source recheck also passed |
| Calls, real screen share, group removal/room rotation, native denial | **3 passed**, exit 0, 71.882s command |
| Actual killed-SFU recovery plus delayed real camera capture | **2 passed**, exit 0, 82.211s command |
| Integrated offline chat/private files/avatars/moderation/media/deletion journey | **1 passed**, exit 0, 117.326s wrapper |
| Deliberate failure after real connected media | Passed negative check: invalid operator ownership was rejected before the SFU kill, original error retained, both auxiliary contexts closed, no teardown/test timeout |

The final browser gates total **6 distinct cases**, no automatic retries, skipped tests or raised deadlines. Calls/recovery runner results and private logs: `.cache/browser-gates-43523fe8-a23a-4f42-8b06-8cec34015926/`. Journey and command/negative-probe results: `.cache/ci-media-recovery/`. Prior unsuccessful attempts remain recorded separately rather than counted as successful commands. Intentional room interruption/rotation can emit SDK closed-channel/reconnect and Vite proxy errors; media and authorization assertions still run.

Final tools/lint rechecks passed. Original **2 users, 9 migration markers and all 40 ordinary collection fingerprints match** the previous checkpoint. Zero fixture databases and zero original-provider rooms remain; dependency/container/listener checks are recorded in the plan. Applied migrations, brief and dependency lock/policy are unchanged. No service reset, commit, push or deployment was performed.

Hosted Linux CI must still be rerun after an authorized push; the exact earlier native group/upgrade teardown cause remains unisolated. The supported compatibility mode and explicit success/failure media teardown are locally tested fixes, not a claimed Linux root-cause proof or a reliability/capacity result. Forced TURN/Linux webhooks, native push/provider display, hardware/other browsers, manual accessibility and production deployment/recovery/capacity gates remain open. Resume Phase 09C/09D as recorded in the implementation plan; no product phase is advanced by this correction.
