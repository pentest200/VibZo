# Codex implementation prompt — production-focused web messaging and calling

Copy the instructions below into Codex, or attach this file and ask Codex to follow it. This is an implementation brief: Codex must create and maintain `implementation_plan.md`, then build the application in verified phases.

---

You are the implementation owner for a complete web messaging application with voice calls, video calls, and screen sharing. Build working software with explicit correctness and recovery guarantees. Treat this as a substantial engineering project, not a UI mockup or an architecture-only exercise.

## 1. Your first action and execution rules

1. Inspect the repository, existing code, package manifests, git status, and applicable `AGENTS.md` instructions. Preserve unrelated work. If the repository is empty, initialize the project described below.
2. Create `implementation_plan.md` at the repository root BEFORE application implementation. Make it repository-specific: describe decisions, module ownership, schemas, contracts, phases, risks, tests, and acceptance criteria. Include readable Mermaid diagrams.
3. After creating the plan, immediately implement Phase 00 in the same session. Do not stop after writing a plan or request routine approval for implementation already authorized by this prompt.
4. Work sequentially through verified phases as session capacity allows. At each phase boundary, update the plan and a short progress record. If the session ends, leave exact completed work, failed checks, blockers, and next actions so a later `Continue` resumes without restarting.
5. Make routine engineering decisions yourself and record the reasoning. Ask only when a missing requirement materially blocks implementation. Do not purchase services, deploy publicly, change external accounts, or expose a public service without explicit authorization. Local implementation, local integration services, and tests are authorized.
6. Use currently supported stable versions and official documentation. Pin dependencies and container versions; retain a lockfile. Verify SDK APIs rather than guessing. Do not assume the newest version number from memory.
7. Do not introduce microservices, Kafka, Kubernetes, multiple backend languages, or additional databases without a measured or documented requirement. Modular boundaries and separately runnable processes are sufficient initially.
8. Never claim a check passed unless it ran successfully. Never claim production readiness, throughput, exactly-once delivery, zero downtime, or complete security without defining and testing the scope. Clearly distinguish implemented, verified, environment-blocked, and deferred capabilities.
9. Avoid placeholder production logic, fabricated users in the real UI, success responses for failed writes, decorative buttons, and mock integrations presented as working features. Keep seed fixtures and test doubles explicitly development-only.
10. No mobile application. Build a responsive WEB application only.

## 2. Product scope

Implement:

- Registration, login, logout, password reset, email verification, and active-session management.
- Profile with unique username, display name, avatar, and privacy settings.
- Bounded username search and direct-conversation creation.
- Direct and group messaging; group creation, invitations, roles, membership removal, and leave operations.
- Text messages, replies, edit/delete operations, reactions, attachments, typing indicators, approximate presence, unread state, delivery/read receipts, and cursor-paginated history.
- Reliable reconnection, offline pending sends, multi-tab synchronization, and missed-event recovery.
- Voice/video calls for direct conversations and groups, invitations/ringing, accept/decline/cancel/timeout, mute/unmute, camera toggle, device selection, screen sharing, participant lists, removal, and call history.
- Web notifications where supported, with explicit user consent. Provide an in-app fallback when background delivery is unavailable.
- User blocking, abuse reports, and a minimal protected moderation workflow.
- Account deletion and configurable content/attachment retention workflows.

Set explicit initial limits for message length, group size, attachment types/sizes, concurrent sessions, call participants, and call duration. Put limits in validated configuration. State that these are initial product/cost limits, not demonstrated infrastructure capacity.

Do not implement native mobile clients, federation, AI agents, transcription, recording, payments, enterprise SSO, or end-to-end encryption in the initial release. Document extension points and the consequences of adding E2EE. HTTPS/WSS and WebRTC transport encryption must not be described as application E2EE.

## 3. Language and stack

Use TypeScript for all application code, with strict compiler settings and runtime input validation.

- Web: React + Vite + TypeScript; React Router; TanStack Query for server state; a small client-state solution only where needed; Tailwind CSS; accessible reusable UI primitives.
- API: Node.js supported LTS + NestJS, with a Fastify adapter if compatible with selected integrations. Keep transport handlers thin.
- Chat transport: Socket.IO with shared runtime-validated contracts and the supported Redis adapter. Configure session affinity if HTTP long-polling is enabled. If choosing WebSocket-only, document its compatibility tradeoff.
- Database: MongoDB, schema-managed through Mongoose or the official driver. Choose ONE approach and record why. Use a replica set for transactional integration tests and development. Production topology must provide redundancy.
- Redis: ephemeral presence, typing, rate limits, cache, socket fanout, and revocation signals. Redis must not be the sole source of durable messages or permission truth.
- Broker: RabbitMQ with durable queues, persistent messages, publisher confirms, manual consumer acknowledgement, bounded prefetch, retries, and DLQs. Use replicated quorum queues in the redundant production design; clearly label single-node development limitations.
- Objects: private S3-compatible storage with quarantine and approved-media areas. Select a maintained local implementation after checking its licensing and distribution status. Expose an S3 adapter rather than binding domain code to one vendor.
- Media inspection: isolated workers with actual file-type detection and ClamAV or a documented equivalent scanner. Enforce parser/resource limits. Never approve a file on scanner error.
- Calling: LiveKit client SDK for React and server SDK for TypeScript. Self-host the open-source LiveKit server locally by default. Keep an environment-configurable LiveKit Cloud option; no paid account should be required for local development.
- Email: a provider interface with Mailpit locally; production provider configured through secrets. Password-reset and verification flows must work locally.
- Web push: standards-based push with a service worker and private VAPID configuration; handle permission denial, expired subscriptions, and unsupported environments.
- Observability: OpenTelemetry, structured redacted logs, Prometheus metrics, and an example Grafana dashboard. Keep heavy local observability services in an optional profile.
- Tests: unit/domain tests, real-service integration tests, Playwright multi-user browser tests, and a reproducible load/failure harness. Select test tooling compatible with the repository.
- Tooling: pnpm workspace, Docker Compose, CI, and production deployment documentation. Add Terraform only for a concrete chosen infrastructure target, not speculative boilerplate.

Do not write a custom SFU, codec, Go service, C++ media worker, or TURN implementation. LiveKit's implementation language does not require our application to use Go.

## 4. Repository structure and boundaries

Start with a structure similar to:

```text
apps/web
apps/api
apps/gateway
apps/worker
packages/contracts
packages/domain
packages/config
packages/observability
infra/compose
infra/observability
tests/integration
tests/e2e
tests/load
docs/architecture
docs/runbooks
implementation_plan.md
README.md
```

Adapt to an existing repository instead of replacing it unnecessarily. Shared domain code owns authentication policy, authorization, validation, and state transitions. The API and gateway call those same rules. Separate processes enable independent deployment and scaling; they are not an excuse to duplicate business logic.

Keep browser-safe schemas separate from server-only packages. Never expose server SDK secrets, database clients, signing keys, storage credentials, or internal tokens through frontend imports or build-time variables.

## 5. Required architecture and flows

Document and implement these relationships:

1. Browser -> static asset delivery and HTTPS/WSS edge -> REST API or chat gateways.
2. API and gateways -> shared authorization/domain modules -> MongoDB transactions.
3. Durable message/event/receipt mutations and their outbox records commit together.
4. MongoDB outbox -> relay -> RabbitMQ -> independent fanout, notification, and other appropriate subscriptions.
5. Fanout consumer -> Redis -> relevant gateways -> authorized client subscriptions.
6. Browser -> authorized history/event replay API -> MongoDB to repair missed live delivery.
7. Browser -> attachment authorization API -> direct scoped upload to private quarantine -> verified finalize operation -> durable scan job -> isolated worker -> approved objects and attachment metadata.
8. Browser -> call authorization API -> scoped LiveKit room credential -> LiveKit signaling and media transport.
9. LiveKit lifecycle notifications -> verified webhook ingress -> durable inbox/reconciliation -> call-state domain logic.

Separate call control from media transport. Our backend owns invitations, membership, permissions, and call history. LiveKit owns WebRTC room signaling and media forwarding. Media packets must never go through the chat outbox, RabbitMQ, MongoDB, or the REST server.

Show HTTP/static traffic, chat WSS, LiveKit WSS signaling, and media/TURN network paths separately. An ordinary HTTP CDN/load balancer does not automatically handle UDP media. Document public addresses, TLS, UDP ports, TURN/TLS fallback, firewall requirements, and networking constraints from official LiveKit documentation.

Provide a system diagram plus focused message-send/recovery, attachment, and call-control diagrams. Each arrow must identify purpose and failure behavior; do not produce a giant unreadable diagram.

## 6. Durable data model and messaging guarantees

Design users, sessions, conversations, memberships, messages, conversation events, receipts, attachments, blocks, reports, calls, participants, outbox events, webhook inbox records, and consumer-effect records. Provide fields, indexes, constraints, retention, and migrations for each.

Required invariants:

- Persist a client-generated `clientMessageId` before sending. Scope a database-enforced unique constraint to `(conversationId, senderId, clientMessageId)`.
- A repeated command returns the original canonical result. Reusing the same key with different content is an explicit conflict, not silent replacement.
- Use a conversation event sequence allocated within the same transaction as the mutation. A message's creation sequence can reference its creation event; define receipt cursors separately and do not confuse event offsets with message counts.
- Use an exact sequence representation across MongoDB, JSON, browser storage, and comparisons. Avoid loss of precision if using BSON 64-bit integers; specify conversion and wire encoding.
- Atomically commit message state, durable conversation event, relevant conversation metadata, and outbox records with documented read/write concerns. Acknowledge acceptance only after a successful durable commit.
- Handle transient transaction aborts, unknown commit results, and bounded retries through the driver's supported transaction mechanisms and command idempotency. Never perform external side effects in transaction callbacks that may rerun.
- All creates, edits, deletions, and relevant reaction/state mutations must be recoverable. Deleting a message must not remove the event needed to tell an offline client it was deleted.
- Do not embed unbounded messages, receipts, memberships, reactions, or outbox arrays in a single conversation document. Set bounds or use separate collections.
- Use compound indexed cursor pagination for messages and events. Avoid large `skip` offsets and unbounded regular-expression search.
- Define behavior for sequence gaps, hidden/redacted events, membership visibility windows, and event-retention expiry. An expired cursor triggers an authorized consistent snapshot, not a silent partial replay.
- Define unread semantics precisely. Edits/reactions should not inflate unread message counts. Make cursors monotonic and test concurrent device updates.
- Document per-conversation counter contention and the initial bounded-group tradeoff. Do not claim this serializes arbitrarily large groups without limits.

Permission correctness:

- Server derives sender identity from the authenticated session, never from user-supplied IDs.
- Enforce membership and role checks on send, edit, delete, history, replay, receipts, room subscription, call join, and attachment access.
- Membership removal and conflicting message writes require a shared transactional guard/version or another demonstrated serialization mechanism. A pre-transaction membership read or snapshot alone is insufficient for strict removal ordering.
- Define blocking semantics for direct messages, groups, calls, presence, history, and downloads. Specify the ordering boundary for concurrent blocking and sending; do not promise a guarantee the implementation cannot enforce.
- Remove affected socket subscriptions after membership changes. Recheck entitlement for fanout and recovery; rooms/caches are routing aids, not authorization proof.
- Define rejoining-history policy and enforce it in queries, snapshots, and downloads.

Status semantics:

- Pending: locally queued.
- Accepted: durably committed by server.
- Delivered: acknowledged by a recipient device under the documented product policy.
- Read: recipient reports viewing through the relevant message position.
- Rejected/failed: explicit error. Ambiguous timeouts require reconciliation before labeling a committed send as failed.

Do not label a socket write as delivery. Do not claim end-to-end exactly once. Use retryable transport with deduplicated creation and idempotent internal effects; explicitly document external-provider ambiguity.

## 7. Outbox, broker, workers, and recovery

- Store the outbox in MongoDB in the domain transaction. A separate database/broker write is not atomic with a message commit.
- Claim pending outbox records using bounded leases and safe compare-and-set updates. Recover expired claims. Use stable event IDs and publisher confirmation before recording publication.
- A crash after broker confirmation but before publication marking may duplicate an event. Implement and test this scenario.
- Use separate RabbitMQ subscriptions/queues for fanout, notifications, and media jobs. Competing consumer groups must not accidentally divide different required side effects.
- Consumers acknowledge only after their required operation completes. Use bounded retry backoff, retry budgets, dead-letter classification, and an authenticated controlled replay procedure.
- Do not premark an effect completed and then perform the effect. Specify atomicity/recovery for each effect. Internal database changes can use a transaction with a deduplication record; external notifications may require provider idempotency keys or documented possible duplicates.
- Redis publication does not prove clients received an event. Durable replay is the correctness mechanism even if the fanout queue drains successfully.
- If the broker is down, committed messages may remain accepted while live delivery/notifications are delayed. Bound backlog/storage growth, expose pending status appropriately, alert on oldest outbox age, and apply admission limits before exhausting storage.
- Never use a small TTL that silently expires unpublished events. Define retention for completed outbox and processed event records so replay cannot reapply expired deduplication records unexpectedly.

Client synchronization:

- Use IndexedDB for pending sends and durable recovery cursors. Scope storage by user and clear sensitive account data on logout/account changes.
- Handle local persistence failure: do not falsely promise refresh-safe delivery when IndexedDB is unavailable.
- On reconnect, authorize subscriptions, buffer live events with a bound, replay through a server watermark, and merge by stable IDs/sequence. Advance cursors only after applying the associated state safely.
- Repair gaps while the socket remains connected by periodic cursor/high-watermark reconciliation with jitter. Recover from gateway/Redis interruptions, not just browser reconnection.
- New conversations, membership changes, and inbox changes need discovery even if the client knows no conversation ID. Implement a durable per-user inbox feed or a versioned authoritative inbox-sync endpoint with equivalent demonstrated behavior.
- Use BroadcastChannel or equivalent for multi-tab coordination without sharing credentials or mixing accounts. A leader-tab optimization is optional, not required for correctness.
- Bound socket buffers. Drop disposable typing/presence updates first; disconnect slow consumers and recover through replay.
- Heartbeats, TTL presence per connection/device, reconnect jitter, connection quotas, and gateway draining must be explicit.

## 8. Authentication and security

Use same-origin web deployment with opaque server-managed sessions in Secure, HttpOnly, appropriately SameSite cookies. Store only session-token hashes and authoritative revocation/expiry in MongoDB. Development exceptions must be explicit. Use Argon2id password hashing with parameters selected against the deployment budget.

Implement CSRF defenses on cookie-authenticated mutations; exact trusted-origin checks on browser socket handshakes; runtime schema validation for every socket message; and explicit connection/session expiry behavior. Do not rely on CORS as authorization.

Provide session rotation where appropriate, logout/revoke-all, password-change revocation, one-use expiring verification/reset tokens stored hashed, rate limits, and non-enumerating responses. Use revocation signals for fast disconnect, plus authoritative checks/bounded revalidation so a Redis outage cannot silently preserve revoked permissions indefinitely.

No secrets or long-lived credentials in localStorage, URLs, logs, bundles, or source control. Add CSP, secure headers, safe text rendering, NoSQL-injection defenses, payload limits, least-privilege database/broker/object identities, secret redaction, and audit events for privileged actions. Protect moderation operations against horizontal and vertical privilege escalation.

Define rate-limit behavior during Redis failure. Critical security controls fail closed or fall back to a documented conservative bound; never silently disable protection. Do not globally take down all read-only messaging solely because approximate presence is unavailable.

## 9. Attachments

- Authorize conversation access and reserve a quota before signing a narrowly scoped upload request. Use generated object keys, size limits, short validity, and upload conditions supported by the storage backend.
- Finalization must verify actual object existence, size, metadata, ownership, and an immutable version/checksum relationship. Prevent overwriting approved bytes through a still-valid upload URL.
- Use explicit states: pending, uploaded, processing, ready, rejected, expired/deleting. State transitions and job creation must be durable and idempotent.
- Detect file signatures, not just extensions or Content-Type. Limit decompression, image pixels, CPU, memory, time, and parser permissions. Restrict risky active formats. Run transformations in isolated processes/containers.
- On scanner failure, quarantine remains inaccessible. A development bypass, if provided, must be loudly labeled and prohibited by production configuration validation.
- Return authorized short-lived download URLs for ready objects only. Choose safe content-disposition and content-type handling. Keep private caching rules explicit.
- Document the remaining download-URL validity window after removal/deletion; do not claim instant revocation of an already issued bearer URL. Proxy authorization if the product needs stricter access semantics.
- Implement abandoned-upload cleanup, orphan reconciliation, rejected-object cleanup, and idempotent deletion jobs. Keep original and derived media access policies consistent.

## 10. Voice/video and screen sharing

Use self-hosted LiveKit for real local integration. Develop a cohesive call UI inside the chat application, with room SDK behavior verified against current documentation.

- Backend authorizes each call action and issues short-lived identity-bound room credentials with minimal grants. Never trust a client-provided room name or role.
- Use unique call/room incarnations so an old credential cannot accidentally address a new call. Define membership removal, token reuse, room ending, and rejoin behavior.
- Do not assume credential expiry disconnects an already connected participant. Explicitly remove revoked users and reconcile call access. Previously issued credentials may permit rejoin during their remaining lifetime; document the bound or implement a provider-supported admission/room-incarnation strategy for stricter semantics.
- Store invitations and call lifecycle durably. Define race-safe state transitions for accept/cancel/timeout, duplicate actions, concurrent device acceptance, disconnect, and room-empty events.
- Verify LiveKit webhook signatures using the required raw-body handling. Persist a deduplicated webhook inbox before processing; handle duplicates, retries, and out-of-order events. Reconcile with current provider room state when necessary.
- Reject unauthorized, ended, expired, or oversized calls; cap token issuance and participant joins. Enforce publisher/subscriber grants and moderator permissions server-side.
- Handle microphone/camera denial, missing devices, device switches, autoplay restrictions, tab suspension, expired credentials, lost network, Wi-Fi changes, and screen-share termination.
- Use SDK-supported adaptive streaming and simulcast where supported; do not invent automatic guarantees. Test screen sharing separately from camera video.
- Provide TURN fallback for restrictive networks and document the configuration. Separate media ports from HTTP edge routing.
- Gracefully drain media nodes; do not claim active rooms migrate transparently or survive node failure without verifying selected deployment behavior. Implement visible reconnect/rejoin recovery.
- Measure call setup failures/latency, packet loss, jitter, round-trip time, quality changes, reconnects, participants, media bandwidth, and TURN use where the selected APIs expose them. Note unavailable metrics instead of fabricating them.
- No media frames in the database or durable message broker. No recording/transcription initially. LiveKit Cloud remains optional; cloud quotas and prices are not architecture guarantees.

## 11. UI requirements

Build a polished, accessible, responsive interface: authentication pages, inbox/sidebar, user search, chat history, composer, attachment progress, group controls, profile/privacy/session settings, reports, and integrated call panels.

Include loading/empty/error states, keyboard navigation, visible focus, contrast, semantic controls, message retry/reconciliation, connection state, unread indicators, and camera/microphone status. Avoid implementation jargon in normal product UI.

Virtualize large histories without breaking scroll restoration, unread markers, focus, or screen-reader behavior. Preserve input drafts. Use real API data. Do not render private conversation content before authorization completes.

## 12. Operations, outages, and cost control

- Design a single-region initial production topology with multiple application instances, redundant database/broker infrastructure, protected Redis, private storage, and separately sized media infrastructure. Document region-outage limitations.
- Explicit dependency timeouts, bounded retries, retry jitter, concurrency limits, DB pool budgets, broker prefetch, and circuit breakers where useful.
- Move CPU-heavy transforms/scans away from Node request/gateway event loops. Monitor event-loop lag, memory, sockets, DB pools, and queue saturation.
- Separate liveness, readiness, and dependency health; avoid cascading restarts when a dependency fails.
- Graceful shutdown drains HTTP requests and sockets, finishes or relinquishes worker leases safely, and stops new call-room allocation before media maintenance.
- Backward-compatible API/event versions and additive migrations for overlapping releases. Test old/new version compatibility for the supported upgrade window.
- Structured correlation IDs across commands, DB events, relay, consumers, and fanout. Redact message bodies, tokens, passwords, and private attachment URLs by default.
- Metrics and alerts: p50/p95/p99 acceptance latency, delivery lag, errors, deduplication conflicts, replay gaps, oldest outbox age, queue age, DLQs, DB replication health, worker failures, call quality, bandwidth, and cost drivers.
- Define availability/latency objectives as targets with measurement boundaries. Do not present untested objectives as results. Define RPO/RTO by failure class, including acknowledged writes and backups; majority acknowledgement does not protect against every regional/destructive failure.
- Backup/restore and point-in-time recovery strategy where available. Restore drills must verify authorization, indexes, attachments, and reconciliation, not only document counts.
- Retention and account deletion must cover messages according to documented group-history policy, objects/derivatives, push subscriptions, logs, caches, and future projections. Explain backup-retention limitations.
- Maintain a dependency-failure matrix for MongoDB, Redis, RabbitMQ, storage, scanner, LiveKit, push/email providers, and the browser's local storage. State allowed operations, rejected operations, recovery, and user-visible behavior for each.
- Track bandwidth, TURN relay traffic, storage growth, call usage, and notification volume. Require no paid services locally. Put nonessential heavy tools behind Compose profiles and document minimum local resources.

## 13. Required implementation_plan.md contents

The plan must include:

1. Scope, assumptions, non-goals, and measurable acceptance criteria.
2. Stack choices, official documentation references, and major tradeoffs.
3. System and focused flow diagrams, trust boundaries, and deployment paths.
4. Module ownership, package structure, data model, index/constraint migrations, and API/socket/event contracts.
5. A production-challenge matrix mapping each challenge above to its concrete fix, owning module, implementation phase, failure test, and remaining limitation.
6. The message, synchronization, attachment, call, and authorization invariants and state machines.
7. Ordered phases with deliverables, prerequisites, acceptance gates, and exact validation commands.
8. Capacity assumptions and benchmark methodology; no invented benchmark values.
9. Security/threat model, operational/dependency-failure matrix, backup/restore, deployment, cost controls, and runbooks.
10. Progress with completed/pending/blocked status and unresolved risks, updated after every phase.

Suggested phases; adapt dependencies but retain the acceptance gates:

| Phase | Deliverables | Acceptance gate |
| --- | --- | --- |
| 00 | Repository inspection, plan, workspace, strict tooling, contracts, local service topology, CI skeleton | Typecheck/build; Compose validation; actual service health; Mongo replica-set transaction smoke |
| 01 | Sessions, registration/login, verification/reset, profiles, shared authorization | Real browser auth; CSRF/origin negatives; revoked/expired sessions rejected |
| 02 | Direct/group conversations, membership roles, blocks, indexed history, functional chat shell | Cross-user access tests; membership/block concurrency semantics; stable pagination |
| 03 | Transactional sends/events/outbox, relay, broker consumers, deduplication | Commit-before-ACK crash; duplicate publication; broker-outage backlog recovery |
| 04 | Multi-instance sockets, IndexedDB, replay, inbox discovery, receipts, reactions, edits/deletes | Offline and connected-gap repair; multi-tab/device convergence; slow-client bounds |
| 05 | Private direct uploads, real scanning, processing, downloads, cleanup | Spoofed/oversized files rejected; scanner outage quarantine; access/revocation-window tests |
| 06 | Notifications, privacy controls, reports/moderation, retention/deletion | Permissions/fallbacks; deduplicated internal effects; deletion reconciliation |
| 07 | Self-hosted LiveKit, call state, voice/video/screen sharing, room permissions | Real two-browser call; group call; permission denial; cancel/accept races; rejoin/removal semantics |
| 08 | Outage behavior, observability, draining, migration compatibility, backup/restore | Fault drills; alerts; restore verification; overlapping-version checks |
| 09 | UI/accessibility polish, documented load tests, deployment/runbooks, final audit | End-to-end feature audit, measured results, known limitations, reproducible clean setup |

Do not postpone fundamental message/permission correctness until a final hardening phase.

## 14. Tests and evidence

Use meaningful tests that exercise invariants and failure boundaries rather than duplicating implementation details. Prefer real MongoDB replica-set, Redis, RabbitMQ, object storage, and LiveKit integration environments for claims about their behavior.

At minimum demonstrate:

- Database-enforced message deduplication under concurrent retries.
- Crash after message commit before sender ACK; same client ID resolves to the original result.
- Crash after broker publication before outbox marking; consumers tolerate repetition.
- Concurrent sends yield unique ordered conversation events; transaction abort retries remain bounded.
- Offline replay includes creates, edits, deletions, reactions, and inbox membership changes.
- Live/replay overlap and a bounded-buffer overflow cannot silently skip durable events.
- Redis interruption while sockets stay connected is repaired by reconciliation.
- Membership removal/blocking concurrent with commands and subscriptions obeys the documented ordering policy.
- Expired/revoked sessions, guessed conversation IDs, forged room subscriptions, and attachment access are rejected.
- Receipt cursors never regress; sparse receipt arrival does not falsely mark a missing message delivered.
- Broker failure, poison jobs, worker crashes, and controlled DLQ replay preserve stated guarantees.
- Malicious-type/oversized attachments, scanner failure, abandoned uploads, and post-approval overwrite attempts are handled.
- Real voice/video calls and screen sharing across two independent browser users; group participant controls; duplicate/out-of-order call events; ended-call credentials; explicit reconnect/rejoin behavior.
- Actual restrictive-network/TURN integration where the environment permits it. Fake media is acceptable for deterministic UI tests but must not be reported as real network/TURN validation.
- Multi-gateway delivery, graceful shutdown, slow clients, and reconnect storms.
- Backup restoration and application-level consistency checks.

Load tests must disclose hardware, topology, versions, users/connections, message rate, group sizes, payloads, duration, warmup, errors, latency percentiles, and memory/event-loop behavior. Test chat and media independently and together. A single-client or same-machine smoke test is not a production capacity benchmark.

If a real browser, network permission, provider credential, or suitable hardware is unavailable, complete the independent implementation and tests, then identify the exact unverified capability and a runnable validation procedure. Do not mark it passed.

## 15. Documentation and definition of done

Deliver:

- Complete source with pinned dependencies and committed configuration templates without secrets.
- Maintained `implementation_plan.md`, architecture decisions, contracts, schema/index migrations, and security notes.
- `.env.example` with explanatory comments, validated configuration, and documented local-only defaults. Production mode must reject unsafe default secrets and unsupported bypasses.
- Reproducible local startup scripts/Compose with health checks, replica-set initialization, object/broker setup, development email, and LiveKit configuration.
- Development fixture accounts generated through a seed command; no privileged production seed credentials.
- CI for typecheck, lint, relevant tests, builds, and appropriate dependency/security checks with actionable handling of findings.
- Runbooks for incidents, queue replay, permission revocation, attachment failures, media troubleshooting, deployment draining, and backup/restore.
- A concise demo script showing functional chat, recovery, attachments, calling, and at least one real failure-recovery scenario.
- A final evidence report separating measured results, unresolved risks, and deferred features.

Working means the web UI, backend, durable event path, private attachment pipeline, and actual calling integration function together. A collection of isolated components or TODO-heavy routes does not satisfy this prompt.

Now inspect the repository, create `implementation_plan.md`, and begin Phase 00. Continue through the phases using the plan as the source of truth.

## Official references to verify during implementation

- MongoDB transaction considerations: https://www.mongodb.com/docs/manual/core/transactions-production-consideration/
- Socket.IO delivery guarantees: https://socket.io/docs/v4/delivery-guarantees/
- Socket.IO multi-node deployment: https://socket.io/docs/v4/using-multiple-nodes/
- Redis Pub/Sub semantics: https://redis.io/docs/latest/develop/pubsub/
- RabbitMQ publisher confirms and consumer acknowledgements: https://www.rabbitmq.com/docs/confirms
- RabbitMQ quorum queues: https://www.rabbitmq.com/docs/quorum-queues
- LiveKit self-hosting: https://docs.livekit.io/transport/self-hosting/
- LiveKit SDK references: https://docs.livekit.io/reference/
- OWASP WebSocket security: https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html
- OWASP file-upload security: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html

If a reference has moved, find its current official location. Match documentation to pinned versions.
