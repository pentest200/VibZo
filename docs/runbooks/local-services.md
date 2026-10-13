# Local services / Phase 00 verification

Run all commands from repository root, with the pinned pnpm CLI on PATH. On PowerShell use `.cmd`. The infra runner points Docker at `.cache/docker` so it does not read inaccessible user Docker credentials or require account login. It assumes the default local engine; use a suitable local engine configuration if yours is remote. Never expose these development credentials or unprotected DB ports publicly.

1. Start a Linux-container Docker daemon. This checkout does not install Docker Desktop, elevate privileges or change system services. `docker --config .cache/docker info` must succeed.
2. `pnpm infra:config` validates Compose (does not verify image existence/probes).
3. `pnpm infra:up` starts and waits for baseline services and initializes approved storage. It checks the approved bucket before creating it and reapplies the development grant; repeat-start idempotency must be integration-verified before Phase 00 acceptance.
4. `pnpm test:integration:foundation` must pass. It uses a random isolated test database, verifies actual two-collection commit/rollback and exact large Long persistence, Redis authentication/TTL, Rabbit persistent publisher confirm + all three separate quorum test queues/manual ACK, private bucket read/write/unauthenticated rejection, and Mailpit HTTP/SMTP greeting. Resources created by tests are cleaned; do not run against production.
5. `pnpm build`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:foundation:http`. The HTTP failure test intentionally uses an unreachable DB and proves liveness stays up/readiness fails; positive readiness is real-service-only.
6. Optional `pnpm infra:media`, `pnpm infra:scanner`; scanner may need several minutes/signature downloads and 2 GiB RAM. They are not substitutes for Phase 05/07 real integrations. Local media UDP mux/TCP bind loopback; LAN calling/TURN require separate configuration and approval before public exposure.
7. Inspect `docker --config .cache/docker compose -f infra/compose/compose.yaml ps` and bounded logs for failed probes. Correct unsupported image/CLI APIs against pinned upstream docs; retain evidence of any failures. `pnpm infra:down` preserves volumes. No automatic volume-delete troubleshooting.

If engine absent: retain environment-blocked status; do not swap in fake services and call it a transaction pass. If broker/storage unavailable during current foundation checks, the integration gate fails. Feature-specific degraded behavior starts in its owning phase.
