# Phase 02 evidence

Session date: 2026-10-16 (Asia/Calcutta). Local Windows/PowerShell, Node 22.15.0, pinned pnpm 12.11.2, existing loopback Docker replica set/Redis/Rabbit/Garage/Mailpit. No deployment or paid/external provider. The brief and earlier implementation were preserved. No new dependency was required.

Implemented: strict browser-safe conversation contracts; additive `002_conversations` validators/indexes and coordinated migration runner; verified-account username search and privacy; canonical direct pairs; idempotent group creation; invitations, acceptance/decline/expiry, roles, ownership transfer, removal/leave/archive; directional blocks and shared authorization guards; separate visibility intervals; exact Long history/inbox cursors; atomic metadata event/reference outbox/inbox writes; real responsive `/chat` shell, contacts/groups/blocks controls and honest empty history. See [conversations runbook](runbooks/conversations.md) for policies and limits.

## Executed checks

| Check | Observed result |
| --- | --- |
| `pnpm db:migrate` | PASS: 001_auth and 002_conversations applied to development DB |
| `pnpm build` | PASS: all shared packages/apps and production Vite bundle |
| `pnpm typecheck` | PASS: final all-source repeat |
| `pnpm lint` | PASS: final all-source repeat |
| `pnpm test` | PASS: 37 unit tests |
| `pnpm test:integration:conversations` | PASS: 16 real-service tests; final run 67.41s |
| `pnpm test:e2e:conversations` | PASS: one multi-user Chromium journey, 54.5s total on final run |
| `pnpm test:integration:auth` | PASS: 14 existing auth tests |
| `pnpm test:foundation:http` | PASS: 3 existing HTTP tests |
| `pnpm test:integration:foundation` | PASS: 6 existing real-service tests |
| `pnpm test:e2e:auth` | PASS: 2 existing Chromium tests, 39.7s total |
| Remote CI | Configured with conversation gates; not executed remotely |

The first new integration run passed 13 tests; the expanded suite passed 15 after adding rollback and keyset-page coverage, then 16 after search cursor/permission/history-bound review. No integration test silently skips missing services. Test databases are dropped by teardown. Browser fixtures are registered and verified through the real local email/API path. Screenshots `.cache/qa/conversations-desktop.png` (1280px) and `conversations-mobile.png` (390px) were opened and visually inspected after the final successful browser run: real group members/controls, empty history, readable layout, no horizontal overflow. Earlier loading-state screenshots were replaced with fully loaded captures. Full accessibility/browser coverage remains Phase 09.

## Correctness evidence

- Real HTTP rejects unverified accounts, forged Origin, absent CSRF, injected sender identity, short search prefix and noncanonical sequence. Existing auth revocation/expiry/Redis-failure regressions passed.
- Concurrent reciprocal direct creation returns one conversation and one durable creation event, with two memberships/inbox hints and one matching outbox row. Mongo unique pair index rejects duplicate stored pairs.
- Concurrent group command retries return the original result; changed content conflicts without extra events. Owner/member/admin permissions, outsider history/detail denial, required owner transfer, last-owner archive and post-removal access denial passed.
- With group capacity set to three, concurrent invitations reserve only two slots beyond the owner. Duplicate acceptance opens one visibility interval. Decline, reinvite, expired acceptance rejection, hidden expired inbox entry and idempotent worker cleanup passed.
- Search omits hidden and blocked identities and exposes no email. Bilateral block creation/unblock semantics, existing direct history, directed contact denial, concurrent direct/block ordering and continued shared-group authorization passed. Inbox and block lists paginate without duplicates over indexed keysets.
- Barrier-held authorization transactions remain ahead of concurrent removal/block operations. After commit, both changes complete and every later guarded operation is denied. These tests exercise actual shared database guard writes, not only preflight reads.
- Test-only stored messages before join/during membership/during absence/after rejoin prove visibility filtering, deleted-text redaction, stable history watermark across a later insert, exact values above 2^53 and the history index query plan.
- Per-user inbox hints discover invitations without a known conversation ID and preserve removals after the item disappears. Exact inbox sequences above 2^53 persist and increment correctly. Snapshot/event paging is tested; a fully consistent multi-page client sync protocol remains Phase 04.
- Admission failure after initial conversation/member writes rolls back those records, command result and inbox state together. Recipient conversation/block quotas serialize concurrent commands. Migration tests reject a live competing lease, recover an expired lease, release ownership and retain strict validators.
- Three independent Chromium users create direct/group conversations, invite/accept, promote admin, transfer owner, remove a member and observe access loss on reload, block/unblock, leave, and use the mobile layout. No credential is written to localStorage.

## Corrections and limits

Final review found and corrected a lower configured MAX_HISTORY_PAGE being ignored; a real-service check now proves the lower bound. Search cursor traversal across blocked candidates and successful admin rename/invitation controls also have explicit coverage. Typecheck caught use of an ES2023 array method against the ES2022 target; replaced it with reversal of the freshly allocated flattened array. A review also separated the fixed two-person direct bound from the configurable group bound. Cached conversation detail now requires a fresh authorization on mounting. Browser evidence initially captured loading states; added actual loaded-state assertions and retook it. Mobile displays selected history/settings before the sidebar.

Earlier automatic approval review could not execute one migration attempt because of an account usage limit. After the user requested continuation, the normal approval path accepted the retry and migration passed. No alternate path bypassed that rejection. No current environment blocker from that attempt remains.

Message sending, broker relay/consumers, socket eviction, offline queues/replay application, attachments, calls, reporting/moderation, deletion/retention and exported telemetry remain unimplemented phases. Pending control outbox records are durable but unpublished; their admission threshold is currently a soft concurrent check. No exactly-once, performance, HA or production-readiness claim is made. The 16-test local suite does not prove production capacity or every failure schedule. No new dependency audit was needed for a dependency-unchanged phase; the earlier successful audit is not represented as a newly executed one.

Status: **Phase 02 verified locally in the scope above.** All listed required local gates passed; no pending failing check. The next resume point is Phase 03 in implementation_plan.md. Browser/API/worker test processes stopped and isolated test databases were dropped on successful teardown. Existing development accounts and dependency volumes are preserved; changes remain uncommitted.
