# Calling

Phase 07 uses LiveKit for signaling, WebRTC transport and forwarding. Mongo owns invitations, first-device acceptance, authorization and history. Only lifecycle references enter the transactional outbox; media never enters Mongo, Redis, RabbitMQ or the application API. Read [Phase 07 evidence](../phase-07-evidence.md) for executed checks and open gates.

## Local startup

Use Node 24.21.0 LTS or a supported Node 22 release >=22.22.0. `livekit-client` 2.23.0 includes a dependency requiring >=22.22.0; the original host Node 22.15.0 is insufficient. The server SDK is pinned to 2.19.1; the self-hosted server is 1.13.9, pinned by image digest in Compose. These are selected pins, not a claim that every pin is the latest release.

```powershell
pnpm.cmd infra:media
pnpm.cmd db:migrate
$env:CALLS_ENABLED='true'
pnpm.cmd dev
```

The API and worker both need `CALLS_ENABLED=true`. Built processes can instead load `.env` explicitly with Node's `--env-file=.env`; the development runner does not automatically load it. Keep API/worker running with the same private provider configuration. Defaults are disabled, so a missing media service does not advertise working calling. `/calls/status` authenticates the user and probes the real RoomService; message readiness stays independent of media availability. There is no browser-accessible provider secret.

The web client explicitly sets LiveKit's supported [`singlePeerConnection: false`](https://docs.livekit.io/reference/client-sdk-js/interfaces/RoomOptions.html#singlePeerConnection). Publication and subscription use separate WebRTC connections so publisher bitrate parameters do not share the subscriber's codec bundle. This compatibility setting uses two ICE/DTLS transports per connected participant; account for both when measuring connections, NAT/TURN allocation demand and capacity. It does not change call admission, authorization, encryption, simulcast or adaptive subscriptions. The [browser CI correction record](../ci-media-recovery-evidence.md) distinguishes executed local regressions from the pending hosted Linux rerun.

Use two verified ordinary accounts in separate browser profiles. Open a direct/group conversation, choose Voice/Video call, and accept from the other account. The call dock remains available while navigating conversations. Microphone/camera/screen controls call the actual SDK. Stop media releases local tracks; Join or rejoin obtains fresh authorization. Accepting on one device binds that call to that session, with a visible explanation on other devices. A quick rejoin waits for the five-second issuance cooldown. An error never constitutes call acceptance or a connected media state.

## Authority and lifecycle

`007_calls` is additive; do not edit applied 001-006. Collections: calls, callParticipants, callRooms, callCommands and callWebhookInbox. Strict validators and unique indexes enforce one open call/conversation and one accepted call/account. Commands use a user-scoped ID plus digest; reuse with changed input conflicts. Conversation/member/user/session/pair guard writes serialize authorization with removal, blocking and revocation. Initial roster is the current verified active members, at most 50. Later members cannot see or accept prejoin calls. An invitation gives no room credential.

Creator acceptance is implicit. Invitees explicitly accept/decline; competing devices have one winner. Ringing lasts 45 seconds; fixed duration defaults to 120 minutes. Accepted participants default to <=12, configurable only downwards. Creator or group managers may end a call; group managers may remove participants under the existing owner/admin hierarchy. Direct decline/leave ends the call. Group leave/removal rotates the media incarnation for remaining participants. A current pair block ends the call. Maximum open-call admission defaults to 1,000, and room generation is bounded to 20; these are product limits, not measured server capacity.

Credentials are accepted-session/current-authority only, for a server-selected unpredictable room and UUID identity. TTL is at most 120 seconds and bounded by session/call expiry. Grants permit only joining, subscription and the selected publishing sources. Voice cannot publish camera; both modes allow screen share. No room creation/admin/list/record, metadata mutation or application data publication is granted. Rate limiting never depends on browser state alone. JWTs remain in component memory; never store them in IndexedDB, localStorage, logs or copied URLs.

LiveKit refreshes tokens for connected clients. Initial JWT expiry is **not** a disconnect or absolute revocation deadline. Self-hosted removal alone does not establish the Cloud token-revocation guarantee. The configured server has `room.auto_create=false`. On lost membership/session/account authority, moderator removal or unknown provider identity, reconciliation deletes the old room and allocates a fresh unpredictable room incarnation. No new-incarnation credentials are issued until all older rooms are deleted. Already-issued bearers may still address the old room until provider deletion succeeds. Provider outage delays revocation; it is not bounded to 120 seconds. Once deletion succeeds, old credentials cannot recreate that incarnation. Users rejoin the new room rather than transparently migrating active media.

Each call has a unique server-time 30-second reconciliation lease with fenced Mongo updates and bounded provider requests. Creation/deletion is persisted before provider work. A lost result is retried against the same room identity. Cleanup retries indefinitely with capped backoff instead of expiring metadata or silently abandoning a failed delete. Ringing/duration limits and a 30-second empty-room grace are checked independently of webhooks. Polling normally runs each second while healthy; queue pressure and dependency failure extend it. No hard revocation latency SLA is claimed.

Deletion immediately revokes the account's application authority, then safety cleanup waits for any nondeleted room incarnation for which it issued credentials. Participant `roomGeneration` retains the last granted generation across rotations. Never clear it when rotating. This ledger prevents account completion while a previously authorized room still needs cleanup. Pseudonymous lifecycle/command/room/webhook references are retained conservatively; finite archival/compaction and backup deletion reapplication remain Phase 08 work.

## Webhooks

`POST /api/v1/webhooks/livekit` verifies the provider JWT and SHA over exact raw request bytes before accepting a reference. Both `application/webhook+json` and JSON raw-body paths are supported; there is a 64 KiB bound. Only this exact provider route bypasses browser Origin/CSRF. Every browser call mutation still requires the cookie, same Origin, JSON and CSRF.

The durable inbox is keyed by provider event ID plus raw digest. Same-ID/same-body retries are accepted; conflicting reuse is rejected. Known room names are resolved server-side; unknown database namespaces are ignored. No raw body, copied participant metadata or media payload is retained. Pending inbox admission is capped at 10,000. Processing only wakes current-state reconciliation: delayed joins/leaves/room-finished events never overwrite a newer incarnation. Periodic reconciliation repairs missing delivery. Docker Desktop routes the local webhook to `host.docker.internal:3000`; on Linux, host loopback may require a deliberately scoped bridge/proxy arrangement. Keep application listeners private and verify delivery on the deployment platform.

## Network paths and TURN

| Path | Local listener | Production requirement |
| --- | --- | --- |
| HTTP/static/API | 127.0.0.1:5173/3000 | HTTPS edge, same-origin browser cookies/CSRF, private API upstream |
| Chat WSS | 127.0.0.1:3001 via Vite | WebSocket-capable edge; separate from SFU media |
| LiveKit signaling/API | 127.0.0.1:7880 | WSS/HTTPS with valid certificate, trusted backend API access |
| Direct RTC UDP mux | 127.0.0.1:7882/UDP | Correct advertised public IP and firewall/NAT mapping |
| Direct RTC TCP | 127.0.0.1:7881/TCP | TCP fallback listener, not an ordinary HTTP route |
| Embedded local TURN | 127.0.0.1:3478/UDP | Authenticated relay, bounded allocations and relay range |
| Local relay allocation ports | 127.0.0.1:50000-50050/UDP | A sized firewall/relay range; local range is not a capacity result |
| Production TURN/TLS | Not configured locally | Dedicated domain/certificate and external TCP443 mapped to the configured TLS listener via L4 routing |

The local SFU advertises 127.0.0.1 and allows only that exact restricted TURN peer CIDR. This is explicitly a development loopback configuration. Do not copy the restricted-peer exception into a public deployment. No custom TURN implementation is used. Browser `VITE_ICE_TRANSPORT_POLICY=relay` forces TURN for diagnosis/testing; normal builds use `all`. An HTTP CDN/load balancer does not carry UDP media automatically. TURN/UDP evidence does not prove TURN/TLS or a corporate-firewall path.

For a production deployment, replace the advertised address, use public signaling TLS, configure `turn.enabled`, `turn.domain`, `turn.tls_port` and trusted certificate/key paths, expose the required TCP listener with L4 routing, retain allocation quotas and verify blocked-UDP fallback with real remote clients. Configure `LIVEKIT_API_URL=https://...`, `LIVEKIT_URL=wss://...` and private nondevelopment API keys on API/worker. LiveKit Cloud is optional through those environment values; enforce an equivalent incarnation/admission policy and test provider-specific webhook/network behavior before claiming support. No Cloud account or paid service is needed locally.

## Failure behavior and operations

| Failure | Behavior / recovery |
| --- | --- |
| Mongo | Authorization/commands/credentials fail closed; durable call and cleanup records remain |
| Redis | Existing auth mutation/rate checks fail closed; media is not an authorization source |
| Rabbit | Committed lifecycle outbox waits; authoritative polling/reconciliation does not require fanout delivery |
| LiveKit API | New calls unavailable; accepted cleanup remains pending with backoff; chat stays available |
| SFU restart/lost room | Media stops; periodic reconciliation allocates a new incarnation; visible rejoin, no active-room migration claim |
| Webhook delivery/order | Signed deduplicated hints; periodic current-room reconciliation repairs loss/order |
| Browser network loss | SDK exposes reconnect state; terminal failure offers Retry media connection / rejoin |
| Device/permission denial | Visible failure and actual enable/device controls; authorized listening can continue |
| Autoplay denial | Explicit Play call audio action; receiving packets alone does not certify speaker playback |
| Browser local storage denial | Existing message fallback applies; call JWTs never depend on durable browser storage |

Worker metrics include `chat_calls_open`, `chat_calls_reconciliation_delayed`, `chat_call_rooms_pending_delete`. They are lifecycle/backlog gauges, not media QoS metrics. SDK connection quality is visible. Connection details show per-component setup latency/failures, participant count and five-second public SDK track-stat samples for received bytes, media bitrate, lost packets, jitter, RTT and direct/relay route where exposed; unavailable fields are labeled. These are local diagnostics, not durable fleet telemetry. Production aggregation, failure/latency histograms and alerting remain Phase 08 work. Do not log SDP/ICE addresses, JWTs, device IDs, names or media bytes to implement those metrics. Drains/restore/node-failure/TLS and capacity drills remain open until their evidence says otherwise.

Checks: `test:integration:calls`, `test:e2e:calls`, `test:e2e:calls:relay`. Browser tests use generated Chromium audio/video, a separate native getDisplayMedia path with generated test surface/automatic selection, and scoped native permission overrides; they do not certify physical devices or other browsers. Tests use isolated Mongo/room namespaces and remove only their own rooms. Existing volumes, mail stores and accounts must survive test setup. See evidence for the exact passing subset.

## Primary references

- [LiveKit client SDK 2.23.0](https://docs.livekit.io/reference/client-sdk-js/)
- [Server RoomServiceClient](https://docs.livekit.io/reference/server-sdk-js/classes/RoomServiceClient.html), [AccessToken](https://docs.livekit.io/reference/server-sdk-js/classes/AccessToken.html), [WebhookReceiver](https://docs.livekit.io/reference/server-sdk-js/classes/WebhookReceiver.html)
- [Tokens and grants](https://docs.livekit.io/frontends/reference/tokens-grants/), [webhooks](https://docs.livekit.io/intro/basics/rooms-participants-tracks/webhooks-events/)
- [Ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/), [selected server configuration source](https://github.com/livekit/livekit/blob/v1.13.9/pkg/config/config.go)

## Verified local TURN fixture — 2026-10-22

`pnpm test:e2e:calls:relay` now provisions a fresh owned loopback SFU/mail pair rather than altering the ordinary development SFU. It configures 32 checked private UDP relay ports, publishes all endpoints on 127.0.0.1, enables a real loopback ICE candidate and allows only `127.0.0.1/32` as the restricted peer exception. Exact owner labels guard cleanup; temporary provider keys/configuration are removed afterward. The strict test retains relay-selected candidate assertions for both users, actual remote frames/audio, screen sharing, signed webhooks and stop/rejoin/end.

The pinned Chromium/Windows fixture needs the existing fake-device UI consent flag without redundant context microphone/camera overrides for this TURN path. Controlled native allocation comparisons retained the failing override mode; explicitly granting local-network permission did not fix it. Normal calling and the separate native-camera-denial case keep their original permission setup. This is a fixture correction, not a JavaScript getUserMedia/ICE stub or a disabled browser network policy. The ordinary SFU/config is preserved. Actual TURN-only media passed with only the exact loopback exception; the broader self-address experiment was removed.

This closes the local end-to-end relay gate, not real restrictive-network/firewall/TURN-TLS/public NAT or Linux host-loopback routing. See [final evidence](../phase-09-final-evidence.md). Relevant pinned server behavior: [configuration sample](https://github.com/livekit/livekit/blob/v1.13.9/config-sample.yaml), [restricted TURN peer validation](https://github.com/livekit/livekit/blob/v1.13.9/pkg/service/turn.go). Playwright supports scoped permission controls through its [BrowserContext API](https://playwright.dev/docs/api/class-browsercontext#browser-context-grant-permissions); observed allocation behavior is specific to the recorded browser/OS control.
