# Bounded local chat and media measurements

Use the pinned workspace Node/pnpm and running existing local dependencies. Build first. The load commands are deliberately restricted to local targets and fixed profiles:

```powershell
pnpm.cmd build
pnpm.cmd test:load:harness
pnpm.cmd test:load:chat
pnpm.cmd test:load:chat moderate
pnpm.cmd test:load:chat step
pnpm.cmd test:load:media
pnpm.cmd test:load:media step
pnpm.cmd test:load:combined
pnpm.cmd test:load:combined moderate
pnpm.cmd test:load:combined step
```

Run commands sequentially. The runner refuses production/remote configuration, insufficient free memory, an existing load lock or occupied application listeners. It provisions a fresh owned DB/topology/object prefix and loopback-only SFU/mail pair; existing ordinary data, service volumes and other projects must remain intact. Do not delete a stale lock blindly: inspect its PID/run ID and corresponding owned fixture first. Operator overrides for arbitrary users, rates, endpoints or duration are not supported.

Small/moderate/step uses 4/8/8 chat users in 1/2/2 four-member groups at 2/4/8 offered sends/s with 256/1024/1024-byte ASCII text. Media has 2/3/3 generated-device users; moderate media is identical to step media and needs no duplicate independent trial. Combined uses separate users, up to 12 total. There are 4s warmup and 12s measured windows. Moderate was added after step hit the unchanged four-inflight safeguard during warmup. Actual durations, scheduling lateness, errors, sample counts and resource observations belong in the report. REST actors use distinct actual loopback source addresses to retain the product's per-IP admission policy; sockets/browser API traffic share loopback. These are colocated test clients, not remote clients or a shared-IP benchmark.

Each command prints a fresh `.cache/load-UUID` directory containing private logs, version/image inventory, numeric measurement and runner outcome when available. Exit 0 requires measured assertions and fixture cleanup. A failed/admission-refused run is not a passing measurement. Never publish raw browser/server logs, screenshots or fixture provider configuration: private diagnostics can contain synthetic identifiers, signaling details and ephemeral credentials. Numeric reports whitelist resource data and omit message bodies, user/conversation IDs, cookies, tokens, device IDs and addresses.

Acceptance latency ends at the HTTP accepted reference. Live-reference latency ends at authorized hint-triggered replay application and excludes message rendering/read receipts. Offline recovery is a separate three-message probe. Duplicate retries, conflict and outsider checks remain distinct from successful offered sends. Media uses actual native generated devices/WebRTC and records decoded frames/byte growth, not a fabricated provider result. The test ends calls and verifies tracks/peers and rooms are released.

Media setup observations start at the owner's call click and include polling delay. Validated media requires more than five decoded frames and 100 inbound audio bytes per user; two or three observations cannot establish tail reliability. RTP counter deltas exclude wire overhead and billed bandwidth. The UI retains adaptive streaming, dynacast and simulcast at its ordinary layout, so these are aggregate per-user observations, not a guarantee that every simulcast layer stays active at full quality. Generated media has lower entropy than a physical camera scene. Resource samples include warmup; their generator-clock boundaries allow comparison with the measured windows. Docker stats adds sampling overhead. Browser RSS and forced TURN are unavailable.

The harness retains the native transport observation that fails, plus bounded call-generation/HTTP-status observations without identities. A setup failure retains partial diagnostics. In a failed combined window, stop new sibling work and await bounded in-flight tasks before closing media/sockets and releasing the fixture. A report's `passed: false` remains unsuccessful even when cleanup passes.

To create reviewable numeric evidence after the runner exits:

```powershell
pnpm.cmd exec tsx scripts/export-load-evidence.ts .cache/load-UUID
```

Replace the placeholder with the exact printed directory. The exporter requires matching completed runner results and both cleanup flags, applies field/privacy/size bounds, and refuses to replace an existing result. Public numeric artifacts live in `docs/measurements/09c`; logs/screenshots and ephemeral provider configuration stay private. Keep earlier unsuccessful attempts alongside a later diagnostic result; never relabel them as passes.

Safeguards: >=1.5 GiB free host memory before admission; stop below 512 MiB, generator RSS >768 MiB, app RSS >512 MiB, backlog >512, lost offered slots or protocol/invariant errors. Maximum four outstanding sends, 90 resource samples, 512 KiB numeric report, 8 MiB private log, 300s test and 480s runner watchdog. These are harness budgets, not service SLOs. Do not lower a budget to disguise an unsuccessful trial. Outer limit/termination and platform-specific paths require their own evidence; inspect guarded cleanup if a process is forcibly stopped.

See [09C evidence](../phase-09c-evidence.md) for actual execution status. CPU/memory/throughput on this single-node Windows/Docker setup do not establish production capacity, hardware behavior, forced TURN, other browsers or deployment readiness.
