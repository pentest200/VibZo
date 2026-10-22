# Phase 09 final local verification checkpoint

2026-10-22, Windows/Docker, entry commit `6dc6c5e`. Existing uncommitted RabbitMQ correction and previous setup work preserved. **Full isolated local setup/demo and local end-to-end TURN passed. All phases are not globally verified:** native push enrollment/provider/display, hosted Linux, manual device/accessibility and production validation remain open. Earlier intermittent media/control-plane observations are retained, not retroactively marked fixed.

## Passing scope

| Verification | Actual result |
| --- | --- |
| Fresh full setup | All **20 operations** passed, sum of step times 244.591s, checked cleanup passed |
| Fresh frozen install/build | Fresh source/node_modules; installed toolchain/package/image caches reused; lockfile unchanged |
| Fresh foundation / auth | **6 + 14 tests passed** on five separately owned dependencies |
| Migrations / restart | All nine markers byte-equal after repeated migration and retained Mongo restart |
| Fresh scanner / browser / decoder | New signature volume, separate owned decoder image/tag/internal network, pinned Chromium downloaded to a new cache; normal scanner readiness passed |
| Fresh integrated journey | **1 passed**, 1.4m suite duration; actual chat/replay/network failure/reload, scanned bytes, avatar privacy, authority/moderation and generated WebRTC/screenshare |
| Fresh webhook route | Independent observation of **2 actual signed participant-joined webhooks** in the owned fresh database |
| Unit | **42 passed**, 9 files, final 704ms; includes bounded diagnostic privacy |
| Setup guards | **4 passed**, final 255ms; paths, foreign ownership, isolated ports, scanner topology |
| Load harness | **7 passed**, final 2.91s; admission, reports/privacy, sibling failure settlement |
| Backend calls / fixture lifecycle / HTTP | **12 + 1 + 3 passed**; 24.14s / 3.94s / 3.53s |
| Normal calling browsers | **3 passed**, 59.8s; direct/group/removal and native camera denial |
| Final strict TURN browser | **1 passed**, 33.7s; relay-selected media, screenshare, actual webhooks, stop/rejoin/end |
| Final three-user media profile | **1 passed**, unchanged profile/deadlines; 7 measured samples, 2 connected RTC transports per user, growing media counters, no call HTTP errors, cleanup passed |

This is **95 passing checks in the affected verification set**, counting the normal/forced-relay transport variants separately. Repeated trials count once; setup operations, the independent webhook observation, native allocation controls and earlier 64-check checkpoint are not added to that count. This is not a rerun of every previous phase suite. Full workspace/tools typecheck, lint/import boundaries and workspace build passed. No dependency version, lockfile, applied migration or original brief was changed.

The full setup is a source snapshot including current uncommitted implementation at snapshot time, not a Git clone or clean OS bootstrap. Private source/manifest/config/logs: `.cache/clean-setup-a4d81a08f0a3461e93cba2616ae51b54/`. The first full attempt `.cache/clean-setup-3e4833682d1b497f974cc9db422ee4e0/` failed at a Vite port tuple type error before service creation; corrected and retained. Full mode requires 4 GiB free host RAM/5 GiB disk/7 GiB configured Docker VM, observes the 512 MiB host-free stop guard, and preserves original services. These are rehearsal safeguards, not production sizing claims. [Setup procedure](runbooks/setup-rehearsal.md).

## TURN diagnosis and correction

The previous gate failed at two boundaries. Counter-only controls showed that explicit microphone/camera context permission overrides stalled loopback relay allocation in this pinned Chromium/Windows combination. A native allocation with the existing fake-device consent flag and no redundant overrides succeeded; granting local-network permission did not fix the failing mode. This is an observed fixture difference, not a general claim about browser internals.

After allocation succeeded, the previous SFU arrangement still failed ICE connectivity: candidate-pair counters showed requests sent without responses. The isolated provider now enables an actual loopback candidate alongside its loopback-advertised address. This behavior is supported by the [pinned server configuration](https://github.com/livekit/livekit/blob/v1.13.9/config-sample.yaml). Its restricted TURN peer policy allows only `127.0.0.1/32`; see [the pinned permission handler](https://github.com/livekit/livekit/blob/v1.13.9/pkg/service/turn.go). The exploratory extra exception for the container's own private address was ineffective by itself and removed. No broad private CIDR, original SFU reconfiguration, SDK/SDP patch, fake ICE result, direct-media fallback or widened deadline.

`test:e2e:calls:relay` provisions its own labelled provider/mail pair with random keys, 32 checked UDP relay ports and 36 total loopback bindings. It deletes only its owned containers/configuration. The final test keeps the original positive media/control/authorization assertions and requires every selected local candidate to be relay. Supplemental native allocation probes were removed from the final test; finite negotiation-state diagnostics remain. Normal calling and native camera denial pass independently with their original permission setup.

Unsuccessful runs are retained under `.cache/phase09-final/`: `relay-current.log`, `relay-negotiation.log`, `relay-allocation.log`, `relay-local-permission.log`, `relay-native-consent.log`, `relay-owned-self.log`. Controls: `turn-controls.mts/json` (5 bounded modes) and the standalone allocation check. Passing progression: `relay-owned-loopback.log`, minimal `relay-final.log`, final-source `relay-source-final.log`. All media/credential/signaling logs remain private. This is local UDP relay evidence; production TURN/TLS, blocked-UDP/public NAT, remote networks and Linux host-loopback webhook routing remain unverified.

## Three-user measurements and earlier failures

The unchanged diagnostic three-user step passed in `.cache/load-6cc56ae9-ed9c-4824-9530-aff6ac574fc2/`. It did not reproduce the earlier 503s, so no causal backend fix is claimed. Added allowlisted error reason/transaction flags and finite operation/elapsed-time logs without messages, endpoints, stacks or identities for future investigation.

Those diagnostics exposed a separate acceptance-selection race: the old query observer requested `/calls/null` after selecting an incoming call. Refetch now runs only when the observer already refers to that call; selecting a different call starts its correct query on the next render. The integrated journey asserts no null/undefined call-detail requests.

Final-source media `.cache/load-a34ccf61-a9a2-4af5-8ac3-f6476c2b6eaf/` passed with **3 users**, no call HTTP errors, 7 measured native samples, media growth and actual release/room cleanup. Validated setup observations: min 3390.84ms, p50 3423.87ms, max/p95/p99 3912.33ms. Three samples do not establish tail reliability. Public numeric records preserve the earlier failure, the diagnostic pass (`media-step-diagnostic-passed.json`) and final pass (`media-step-passed.json`) separately in [measurements](measurements/09c/media-step-passed.json).

Larger chat/combined trials remain censored by the unchanged four-inflight safeguard during warmup. Their failed records remain valid disclosed outcomes, not measured throughput windows or a backend saturation knee. No product throughput/SLO was promised by those profiles, and no budget was raised to get a pass. [09C evidence](phase-09c-evidence.md) retains the earlier failures and limitations. The precise intermittent 503 cause remains an open reliability risk.

## Native push: attempted, not passed

Bundled Chromium denied native notification permission. Pinned Firefox 157.0 granted native permission but native enrollment exceeded 45s; the attempt with its ordinary [Mozilla service URL](https://github.com/mozilla-services/autopush-rs) explicitly configured also failed to finish. Installed Chrome 155.0.8059.85 granted permission but native subscription failed, including a control with ordinary background networking restored. No synthetic payload was sent when enrollment failed. No JavaScript permission or PushManager stub is counted as native success.

Added `test:push:native [chrome|firefox|chromium]` as a repeatable operator preflight: owned loopback page/service worker/profile, ephemeral VAPID keys, actual production provider adapter, generic payload, finite deadline and checked unsubscription/browser/listener cleanup. It logs finite stages only. Final Chrome command **failed at subscription**, native permission granted, local cleanup passed, remote subscription not created: `.cache/native-push-5b7d0021-f1af-4544-88d1-36958d4aa27e/result.json`. This negative result is not one of the 95 passes. Provider acceptance, end-to-end delivery, browser/physical display and the full account UI/provider flow remain unverified. [Native procedure](runbooks/safety.md#repeatable-native-provider-check).

## Preservation and remaining gates

Final comparisons passed: original **2 users**, **9 migration markers**, **40 ordinary collection fingerprints** unchanged; zero fixture databases/original-provider rooms. User hash `96a438f46142093c0e561d23c7c79e7db931ea3a57b788d0dd21a428dd456bd0`; markers `9102b4958dabf63a97ad27c73dc5db56bab7a33e0035509fb3b48a38b8a6c665`; 009 source `be0501e282ff7c5765121ce2a515c3715381044656e8cbfd5f0f17120200ea19`. No owned setup containers, volumes, networks or images, media/mail containers, or application listeners remained. Original eight dependencies healthy and original LiveKit up. No ordinary service restart/reset, commit, push or deployment.

Remaining, in order: a compatible real push-enrollment target; authorized hosted Linux CI and webhook/signal validation; manual native assistive-technology/device/other-browser review; production TLS/IAM/rotation/HA/orchestrator and independent-host/PITR/regional recovery/capacity validation. Keep the earlier 503 risk and generator-censored profiles visible. The current implementation does not supply external infrastructure or evidence by itself. An environment/device/runner clarification is pending; do not invent successful external results or deploy without the required target and authorization.
