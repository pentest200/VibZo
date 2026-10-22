# Security and deployment boundaries

The implemented system is described in [the implementation plan](../../implementation_plan.md), validated by `packages/config/src/index.ts`, and scoped by the [feature audit](../phase-09-feature-audit.md). The local Compose file is a development topology: loopback listeners, documented credentials, unauthenticated single-node Mongo and no dependency TLS. Production configuration validation rejects insecure defaults; provisioning and production verification have not been executed.

| Boundary | Implemented policy | Residual limit / operational evidence |
| --- | --- | --- |
| Browser → application | Origin/CSRF guards, server-derived identity, hashed opaque sessions, HttpOnly cookies; production Secure cookies/HTTPS | Browser XSS remains within a signed-in user's authority. Never expose server secrets through `VITE_*`. [Auth](../runbooks/auth.md) |
| Membership/block → mutation | Shared transactional conversation/member/pair guards serialize conflicting entitlement changes | Live rooms are routing hints, not authorization. Recheck replay/download/call entitlement. [Conversations](../runbooks/conversations.md) |
| Commit → broker → browser | Majority journaled message/event/outbox commit before acceptance; confirms, leases, idempotent effects, authorized replay | Repeated hints are expected; live delivery/readiness is not a durable receipt. [Messaging](../runbooks/messaging.md), [sync](../runbooks/synchronization.md) |
| Upload → approved object | Reserved quota, capped byte capture, actual scanner/decoder, fresh approved key, purpose-scoped metadata | Failures stay private. Existing download bearers remain usable for their bounded lifetime; previously downloaded bytes cannot be recalled. [Files](../runbooks/attachments.md), [avatars](../runbooks/avatars.md) |
| Call authority → media | Accepted participant/generation checks, short credentials, room rotation/removal/reconciliation | Token expiry alone does not disconnect peers. Transport encryption is not E2EE. Native device/remote TURN/platform gaps remain. [Calls](../runbooks/calls.md) |
| Operator → jobs/recovery/telemetry | Bounded audited replay, private diagnostics, encrypted restore into fenced namespace, explicit resource ownership | Production identity/key custody, private metrics ingress and independent-host restore require provisioning. [Operations](../runbooks/operations.md), [recovery](../runbooks/recovery.md) |

Production release prerequisites are unexecuted requirements, not deployment instructions that have passed:

1. Provision an authenticated TLS edge for assets/API/chat with restricted health/metrics/operations paths and WebSocket forwarding. Provision a separate media signaling/TURN endpoint with correct certificates, advertised addresses and UDP/TCP firewall routes. Validate the real restrictive-network path.
2. Provision production Mongo replica discovery/TLS/auth, Rabbit quorum nodes, Redis HA/auth/TLS, private redundant object storage and authenticated TLS email/image processing. Set explicit secrets through the deployment's secret manager; rotate and prove revocation with the corresponding runbooks. Do not copy development Compose credentials or seed privileged users.
3. Start compatible migrations as a controlled release action, deploy current avatar-capable workers, test readiness/drain/rollback with the target orchestrator and keep message v1 compatibility within the [upgrade policy](../runbooks/upgrade.md). Test Linux signal behavior and rerun actual hosted CI; local Windows evidence does not close them.
4. Validate independent-host encrypted restore, current-policy enforcement, key custody and recovery objectives. The existing local copy drill does not provide PITR, regional failover or a production RPO/RTO.
5. Resolve the disclosed load/media failures and size independent generators/hosts before setting an SLO or capacity number. Obtain native push provider/display, hardware/browser and manual accessibility evidence for the intended deployment. [Measured results](../phase-09c-evidence.md) remain limited to their actual trials.

No production infrastructure, public deployment, external-provider delivery or release approval is claimed by this document. The [09D evidence](../phase-09d-evidence.md) records the local acceptance boundary.
