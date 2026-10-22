# Phase 09C bounded measurement evidence

Status: all three modes implemented and all planned small/step profiles actually attempted, plus moderate chat/combined. Small chat/media/combined and moderate chat passed; larger trials failed or were censored. Final source/lifecycle/preservation checks passed. **Phase 09C remains partially verified:** three-user media stability and the larger combined profiles are not established. No production capacity or full Phase 09C completion claimed.

The [plan](../implementation_plan.md) defines architecture and budgets before implementation. Preserve committed 09A/B and all uncommitted media-CI corrections. The original two users, nine migration markers and all 40 ordinary collection fingerprints matched after Docker startup. Docker was initially stopped; starting its existing engine resumed original containers/volumes without recreation.

## Scope and methodology

Host: Windows, Intel i5-13450HX, 10 physical / 16 logical processors, approximately 16 GiB RAM. Docker Linux engine 29.7.2 exposes 16 CPUs and 8,205,791,232 bytes of VM memory. API/gateway/worker, generator, generated-device Chromium and shared single-node dependencies are colocated. Each trial records actual runtime/package/image versions. Vite serves the development web; these are not production asset/CDN or independent-host/network measurements.

Fixed small/moderate/step profiles: 4/8/8 chat users, 1/2/2 four-member groups, 2/4/8 offered sends per second, 256/1024/1024 ASCII-byte bodies; one outsider for denial checks. Media has 2/3/3 distinct users and 4/6/6 active RTC transports under the prior dual-peer compatibility setting. Combined uses separate chat and media users, up to 12 accounts. Four-second warmup, twelve-second measured windows, at most four outstanding sends, bounded logs/reports/samples/deadlines and resource stop conditions are unchanged. Moderate was added after the step profile hit the unchanged generator guard; it narrows the range without changing admission or safeguards. The private SFU has a 1 CPU / 512 MiB cap.

The API's actual mutation guard is 60 requests/minute/IP. REST actors therefore use distinct genuine TCP sources `127.0.0.2` through `.13`, not forwarded IP headers or altered admission settings. A native HTTP probe verified the source binding. Socket and browser requests share loopback. This models separate REST client addresses on one host; it does not measure a shared-IP/NAT deployment's admission behavior. Existing authentication, hashing, authorization and rate limits remain enabled.

Write acceptance is HTTP start to canonical accepted reference. Live delivery is HTTP write start to authorized replay references applied by each subscribed synthetic client after real gateway invalidation; hints are not per-message deliveries. It excludes content fetch/render and read-receipt latency. The harness checks cursor ordering/event uniqueness, exact final bodies/IDs/counts, same-ID dedup, changed reuse conflict, outsider denial, and a separate three-message offline reconnect/replay. Nearest-rank p50/p95/p99 include sample counts; empty distributions are null.

Media uses the actual UI, native generated camera/microphone and real private SFU. Setup is measured from the owner click to connected, remote-video readiness observed by polling, and validated media (>5 decoded frames and >100 inbound audio bytes). Polling adds observation delay. RTP byte-counter deltas exclude wire overhead and billed bandwidth. Generated media has lower entropy than a physical camera scene; ordinary adaptive streaming/dynacast/simulcast and layout remain enabled, so per-user aggregates do not establish full-quality transmission of every layer. Packet loss, available jitter/RTT/bandwidth/route class, app process RSS/CPU/event-loop/backlog, host memory, generator event-loop delay and SFU CPU/memory are recorded. Browser RSS, physical devices, restrictive network/TURN and production capacity are not established. Two or three setup samples do not establish tail reliability. Runtime samples include warmup and record clock boundaries where available; Docker stats overhead and effective sample times are retained.

## Attempts and verified checks

- Build passed. Initial tools typecheck passed. Initial lint found an unsafe throw in a finally block; report serialization moved to a bounded helper, retaining the bound. Tools and corrected lint/boundaries then passed.
- Seven final harness checks passed: fixed argument/resource admission and remote/production refusal; nearest-rank/empty/invalid distributions; bounded numeric whitelist/private-label filtering; refusal of ordinary/malformed Redis cleanup namespaces before connection; public evidence privacy/identity filtering; artifact depth/array/byte bounds; sibling failure cannot release cleanup before an admitted write settles. The last uses explicit promise barriers without timing sleeps. Full workspace/tools typecheck and lint/import boundaries also passed after the latest diagnostics and sibling-drain correction.
- Two initial chat invocations refused before creating a fixture because launcher-time free memory was below the unchanged 1.5 GiB preflight budget. No traffic was generated. A proposed temporary idle-ClamAV stop was not executed because automatic approval review hit a usage limit (review failure, not an unsafe-action determination). After the user's Continue, approval review and read-only inspection worked; observed free memory was about 3.2 GiB, all original services including ClamAV remained healthy, and the trial resumed without stopping any original container.
- Earlier admitted small chat calibrations passed and remain private under `.cache/load-8341f0ef-f6b7-444c-a6ff-37a18ea5957d/` and `.cache/load-b82de58d-33d8-422d-8a0a-0748365c81b0/`. The final disclosed small chat trial is a separate result; successful runs are not pooled.
- Chat step failed during warmup: 10 offered, 9 accepted, 1 dropped at the four-inflight safeguard (`offered_slot_lost`). Zero measured messages/latency samples. This is a harness ceiling, not a demonstrated backend saturation knee; it does not prove that 8/s is sustainable or impossible.
- Three-user media attempt `.cache/load-aa9dbb9e-9d0e-4128-9d96-cb82bc7cf307/` connected all users, then lost an expected transport during measurement. The offending sample was originally thrown away before serialization; diagnostics now retain it. The first diagnostic rerun `.cache/load-94951c94-df98-4547-8b4d-5ecad90979d7/` failed setup with only one of two remote videos ready. Both unsuccessful trials retain private logs/reports and passed owned cleanup.
- The next diagnostic `.cache/load-172cbeb4-4c46-4e18-9476-71f46c8a14d0/` again failed during measurement. All three initially had two connected transports; the owner's later sample had two closed transports while the others remained connected. Safe call observations show two HTTP 503 responses to that user's call polling beforehand, with generation 1 throughout. The UI closes media on a failed authoritative call refresh. This explains this observed shutdown; the underlying 503 cause is not isolated. No connection criterion, HTTP limit, deadline or production authorization behavior was weakened. The public result remains censored.
- Combined small passed with independently created chat/media users, overlapping measured windows, exact chat invariants and natural SDK media release. A harness review found and fixed a failure-path race: a rejected window now stops sibling generation and awaits both bounded tasks, including pending sends, before cleanup. Setup failures retain numeric diagnostics. Hard watchdog termination branches have not been directly exercised by these normal exits.
- Combined moderate and step both reached warmup with three-user media prepared, then stopped at the four-inflight guard: each offered 5, accepted 4 and dropped 1, with zero measured messages and no measured media window. Their setup observations do not demonstrate sustained three-user stability. Both application/provider cleanup flags passed, with no watchdog termination. These censored results are separate from independent chat moderate's passing result.

## Disclosed measurements

Each JSON links one completed trial and includes inventory, bounds, distributions, resources and runner cleanup outcomes. Warmup is excluded from chat latency distributions. Achieved rate includes the bounded live-reference drain after the 12s offered window. Nearest-rank tails with small sample counts are descriptive, not reliable capacity estimates. Failed trials are retained, not averaged into passes.

| Trial | Accepted / recipient references | Acceptance p50 / p95 / p99, ms | Reference application p50 / p95 / p99, ms | Achieved accepted/s including drain | Offline replay, ms |
| --- | --- | --- | --- | --- | --- |
| [Chat small](measurements/09c/chat-small-passed.json) | 24 / 96 | 238 / 883 / 1168 | 647 / 1779 / 2156 | 1.949 | 189 |
| [Chat moderate](measurements/09c/chat-moderate-passed.json) | 48 / 192 | 176 / 302 / 788 | 1184 / 3463 / 3789 | 3.379 | 241 |
| [Combined small](measurements/09c/combined-small-passed.json) | 24 / 96 | 395 / 1523 / 3068 | 1165 / 3694 / 5528 | 1.769 | 267 |
| [Chat step, censored](measurements/09c/chat-step-censored.json) | 0 measured / 0 | null (warmup failed) | null | null | unverified |
| [Combined moderate, censored](measurements/09c/combined-moderate-censored.json) | 0 measured / 0 | null (warmup failed) | null | null | unverified |
| [Combined step, censored](measurements/09c/combined-step-censored.json) | 0 measured / 0 | null (warmup failed) | null | null | unverified |

All passing chat rows had zero lost offered slots, same-ID retry identity, changed-payload conflict, outsider denial, exact final snapshots, durable message count and three-message offline recovery checked. Explicit retry timing samples include warmup and offline probes and are separate from new-message acceptance samples.

| Media trial | Validated setup min–max, ms (count) | Received / sent RTP kbit/s per user | Media samples | Result |
| --- | --- | --- | --- | --- |
| [Media small](measurements/09c/media-small-passed.json) | 7614–7619 (2) | 194 / 192; 193 / 195 | 7 | Passed; tracks/peers/rooms released |
| Combined small | 8027–8526 (2) | 200 / 199; 198 / 200 | 7 | Passed; tracks/peers/rooms released |
| [Media step, censored](measurements/09c/media-step-censored.json) | 18748–19473 (3) | Partial connected interval only; see JSON | 3 including failure | Failed after call-refresh 503s; cleanup passed |

## Sampled resources

These peaks cover runtime sampling including warmup and drain, not solely the offered window; generator clock boundaries are in newer reports. Samples are sparse and include monitoring overhead. CPU counters and per-process event-loop values are retained in the JSON, along with SFU memory and QoS observations; no independent browser RSS is available.

| Trial | Runtime samples | API / gateway / worker peak RSS, MiB | Generator event-loop p99 / max, ms | Outbox / fanout peak | SFU sampled CPU peak |
| --- | --- | --- | --- | --- | --- |
| Chat small | 10 | 142 / 126 / 142 | 36.8 / 42.5 | 1 / 1 | not sampled |
| Chat moderate | 12 | 158 / 129 / 151 | 34.9 / 57.5 | 1 / 1 | not sampled |
| Media small | 9 | 176 / 116 / 141 | 36.4 / 88.7 | 0 / 0 | 10.72% |
| Combined small | 9 | 197 / 129 / 151 | 45.3 / 119.1 | 1 / 0 | 8.39% |
| Media step, censored | 5 | 245 / 116 / 146 | 69.3 / 146.5 | 0 / 0 | 10.22% |
| Combined moderate, censored | 5 | 228 / 127 / 144 | 66.8 / 218.1 | 0 / 0 | 15.54% |
| Combined step, censored | 4 | 238 / 143 / 142 | 61.3 / 157.3 | 0 / 0 | 11.34% |

No runtime memory/backlog safeguard fired in these disclosed trials. This does not explain or excuse the media 503 failure. Old chat-step report predates the generator histogram sample-count and absolute-clock fields; empty measured distributions remain explicit. Reports identify HEAD `97fcf1f` and a dirty working tree, rather than claiming these uncommitted changes were already in that commit. Package/image pins are recorded per result.

## Final checks and preservation

| Command/check | Result |
| --- | --- |
| Workspace build before stable browser trials | Passed |
| `pnpm test:load:harness` | 7 passed, 2.44s final command |
| `pnpm typecheck` | Passed, workspace and tools |
| `pnpm lint` | Passed, ESLint and browser boundaries |
| `pnpm test:integration:e2e-lifecycle` | 1 real-service ownership/cleanup test passed, 8.91s |
| Numeric artifact exporter | Eight representative passed/censored reports exported with matching completed cleanup results and privacy/size validation |
| Original preservation | 2 users, 9 markers, all 40 original collection fingerprints unchanged; zero fixture databases/rooms |

All measurement/verification processes have exited. The original eight dependency containers are healthy and original LiveKit remains available. No original service was stopped to make a trial fit. All eight disclosed trial runner outcomes report successful owned application/provider cleanup; no load lock remains. Private logs/failure screenshots and calibration results remain under ignored `.cache/load-*` and `.cache/phase09c-checks`. No source dependency, lockfile, applied migration, ordinary data reset, commit, push or deployment was required. The prior media-CI corrections remain preserved and their hosted Linux result stays unverified.

Public results are one representative final record per mode/profile/outcome, not pooled statistics. Earlier calibration and failed diagnostics remain privately retained and described above. SDK quality-tier transitions, per-layer resolution/fps, transport-wire cost, browser RSS and remote-network/hardware/TURN behavior were not measured; RTP/QoS counters must not imply those capabilities. Passing small trials do not establish a production SLO or a backend saturation knee.

## Exact remaining gates

1. Diagnose the authoritative call-refresh 503s observed in the disclosed three-user media trial. Add only bounded safe error classification/timing if necessary; preserve no bodies, credentials, SDP or identities. Do not assume SFU saturation, room rotation or the prior Linux codec issue caused these responses. Preserve authorization on uncertainty and all existing deadlines/media assertions. Run the affected media/API regression after a justified fix, then repeat the same three-user trial and retain both outcomes.
2. Larger chat/combined profiles remain censored by the four-inflight harness ceiling. Any future investigation must disclose a separately designed workload/budget and generator/host sizing; do not silently raise the cap, weaken correctness, or relabel the current warmup-only outcomes as measured throughput. Repeat the existing profiles after justified performance changes if their gate is to be closed. No backend capacity knee has been demonstrated.
3. Phase 09D clean setup/demo/final audit is pending: resource-budget an isolated checkout/Compose project with distinct ports/volumes, prove the documented setup, write an actual failure/recovery demo and reconcile final evidence with these failed gates. Preserve this checkout and applied 001–009. Earlier native push, hosted Linux CI/webhook/signal, forced TURN, manual accessibility, hardware/other-browser and production recovery/deployment/capacity gates remain open. No remote push/deployment is authorized by this task.

## 2026-10-22 continuation — three-user step passed

The unchanged diagnostic three-user media step passed with new safe API error classification; the earlier authoritative-refresh 503 did not recur, so its cause remains unconfirmed. That diagnostic pass is preserved as `media-step-diagnostic-passed.json`. It exposed a separate stale observer request to `/calls/null` during incoming-call acceptance. The UI now refetches only a detail observer that already targets that call, and the integrated journey requires no null/undefined call reads.

The final-source unchanged three-user trial passed again: `.cache/load-a34ccf61-a9a2-4af5-8ac3-f6476c2b6eaf/`, public [final numeric record](measurements/09c/media-step-passed.json). Three users, no call HTTP errors, seven measured native samples, two connected transports per user, advancing frames/audio/send counters, normal end/release and owned cleanup all passed. Validated setup observations min 3390.84ms / p50 3423.87ms / max 3912.33ms; three samples do not establish tail reliability. The earlier failed record and both positive records are separate, not pooled or overwritten. No profile/cap/deadline changed. The load harness's seven checks pass.

The larger chat/combined profiles remain warmup-censored at the unchanged four-inflight safeguard; there was no justified performance change to rerun them hoping for green. They do not establish measured throughput or a backend knee. The earlier intermittent 503, colocated single-host limitation and production sizing requirements stay explicit. Full isolated setup and local strict TURN are now separately verified; [final evidence](phase-09-final-evidence.md) gives their scope. Native provider/device/Linux/production gates remain open.
