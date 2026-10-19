# Conversations and membership

This document retains the Phase 02 contacts/group/permission policy baseline. Current sending/broker behavior is in [messaging](messaging.md), and sockets/offline replay in [synchronization](synchronization.md). Run `pnpm db:migrate` before using `/chat` to apply the current additive migration sequence. The explicit runner obtains a server-time Mongo lease, renews it, checks ownership before DDL, and releases by owner/epoch. A busy runner fails with a retry message. Do not delete a live migration lock; an abandoned lease expires after 120 seconds. Never run migrations inside an application request or bypass an incomplete restore fence.

## Account and membership policy

Register, verify through local Mailpit, then choose **Open conversations** from `/account`. Only verified accounts can search, create/read conversations, accept invitations or manage blocks. Search uses a 3–24 character username prefix, returns public identity only, and honors `allowSearch` and bilateral blocks. Changing search privacy prevents new direct contacts/invitations; existing direct conversations remain accessible. Concurrent privacy changes use transaction snapshot eligibility, without a strict instantaneous privacy cutoff.

Direct conversations use a sorted pair of user UUIDs and a unique partial index. Concurrent reciprocal creation returns the same conversation. Groups use a client command UUID and original payload digest for creation retries. Reusing a group creation UUID with another title returns conflict. Other controls reconcile through current state after an interrupted response; do not assume every control has command-key idempotency. In particular, ownership transfer changes who may retry it.

Invitations reserve capacity until acceptance, decline or expiry. The default is 72 hours, configurable with `GROUP_INVITATION_HOURS` (maximum 168). Expired invitations disappear from inbox/member reads and cannot be accepted even if the worker is down. The worker cleans up to 20 per pass with guarded state transitions and durable events. Run the worker for cleanup and auth email. A new invitation after expiry requires current eligibility and quota.

Owners can change roles and transfer ownership. Owners/admins can rename, invite and remove ordinary members; admins cannot remove another admin or the owner. Only owners can remove admins. Owners must transfer ownership before leaving a nonempty group. The last active owner leaving archives the group and invalidates pending invitations. Removed/left users lose detail/history access. Rejoining restores earlier legitimate history and starts a new visibility interval; it does not expose messages before first join or during an absence. Intervals are separate documents, not an ever-growing membership array.

Blocking either direction prevents new direct creation and guarded direct commands. Existing direct participants can read their previously authorized history. Only the blocker sees their block list and can remove that directional block. Both directional blocks must be removed to allow direct contact again. Blocking does not remove users from shared groups or hide lawful shared group history. New directed invitations check the manager/target pair. Send/call/download grants use shared **write** authorization; history intentionally permits blocked direct history. See [synchronization](synchronization.md) for live reauthorization and [calls](calls.md) for room rotation and already-issued credential validity; neither implies instantaneous recall of every bearer credential.

## Storage and ordering

`ConversationService` derives identity from the opaque session and verifies the account inside each transaction. It makes real writes on the user/session, conversation, active membership and (for direct commands) canonical pair guards. Removal/block writes those same guards. The driver retries transient transactions under a 10-second deadline; first-use duplicate-key races have at most three outer attempts. Callbacks must contain only transactional database work, since a callback can run again.

Membership/metadata mutations commit conversation sequence/event, reference-only outbox row and per-user inbox events with the actual state. All sequences are BSON Long in Mongo and canonical decimal strings on the wire. Phase 03 now publishes these rows through its leased relay. Pending rows have no TTL. `MAX_PENDING_OUTBOX` is now protected by the shared transactional admission guard added in Phase 03; all writers must be upgraded and use consistent limits. The earlier Phase 02 soft-count limitation is superseded. See the messaging runbook for backlog metrics and tested scope. Do not clear unpublished rows to bypass admission.

Initial product limits are 50 active/pending members per group, 500 active/pending conversations per user and 500 outbound blocks per user. Configurable maxima are 50, 1,000 and 1,000 respectively. Recipient quota writes serialize through per-user inbox counters. These are product bounds, not throughput measurements. Reads also take guard writes; hot conversation/account contention is a deliberate initial tradeoff.

History uses the unique `(conversationId, creationSeq descending)` index, visibility-interval lookup, a page maximum of 100 and a 3-second query budget. `before` is exclusive and `through` fixes the first page's watermark. Deleted bodies are redacted. Long invisible gaps can still require scanning candidates; visibility-query capacity/optimization remains a Phase 08/09 measurement, not a proven large-history SLO.

Inbox snapshots use membership keysets, with a per-page transaction watermark. The durable `/inbox/events` feed discovers creations, invitations, removals and block changes. Multiple snapshot pages are not one pinned database snapshot: Phase 04 must replay the feed from the first watermark and reconcile authoritative state. No inbox/event retention or cursor-expiry protocol is active yet. The Phase 02 UI polls authoritative snapshots/details every 10 seconds, offers refresh, clears account caches on logout, authorizes a selection before displaying cached history, and hides detail/history after authorization failure. A remote removal can remain displayed until that next successful authorization check; immediate socket invalidation is Phase 04. Network failures show errors instead of asserting removal or success.

## Local checks

Build shared packages, start baseline services, then run:

```text
pnpm db:migrate
pnpm test:integration:conversations
pnpm test:e2e:conversations
```

Integration tests create and drop a unique `conversation_test_*` database. Browser tests create/drop `chat_e2e_auth_*`, start their own API/worker/Vite on ports 3000/3002/5173, and use real email verification plus three independent Chromium contexts. Stop your development processes on those ports first. Set `PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright` before browser installation. Synthetic local Mailpit messages remain; no real account/provider is used. Test-only inserted history messages are clearly labeled fixtures and never displayed as production seed messages.

If a request is interrupted, refresh the authoritative inbox/detail. Direct creation can be retried safely; group creation must retain the original UUID and content until resolved. If the migration marker is missing, protected conversation operations fail closed; run the explicit migration command and investigate its error rather than editing markers. Mongo/Redis outages follow the existing auth runbook. Worker warnings indicate delayed email or invitation maintenance, while acceptance checks continue enforcing expiry themselves.

The migration lease does not provide a database-fenced DDL primitive. Commands have shorter deadlines than the lease, with ownership preflights and renewal. Paused-process and mixed-release schema upgrade drills remain Phase 08. Applied migration markers prevent an old auth migration from replacing a later validator. Never edit an already-applied migration as a deployment upgrade; add the next migration.
