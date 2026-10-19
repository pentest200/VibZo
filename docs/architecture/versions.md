# Versions and decisions

Current local verification uses Node 24.21.0 and pnpm 12.11.2. Historical bootstrap notes below are superseded by the Phase 07 runtime requirement. Real ClamAV/image processing and LiveKit checks are recorded in [Phase 05](../phase-05-evidence.md) and [Phase 07](../phase-07-evidence.md). Phase 08 adds the actual tracing SDK/exporter and pinned private telemetry runtime; see [operations](../runbooks/operations.md) and [Phase 08 evidence](../phase-08-evidence.md) for executed scope. These local results do not certify production deployment or image security.

Queried official npm registry and official project references on 2026-10-13. Exact direct pins live in package manifests and transitive resolution/integrities in `pnpm-lock.yaml`; do not change versions from memory.

- pnpm 12.11.2 current native release; host Node 22.15.0 satisfies bootstrap/runtime engines. CI target Node 24.21.0 LTS. https://pnpm.io/installation ; https://nodejs.org/en/about/previous-releases
- TypeScript 6.0.3 selected over registry latest 7.0.2 because typescript-eslint 8.71.2 explicitly supports `<6.1.0`; legacy Nest decorators validated by build/HTTP test. This is a supported compatibility choice, not an assertion of latest compiler. https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html
- Nest/Fastify 12.1.3; transitive Fastify 5.12.5. https://docs.nestjs.com/techniques/performance
- Vite 8.3.4 / plugin-react 6.1.2; React 19.3.0; Router 7.18.4; Query 5.104.2; Tailwind 4.3.3. Node engines checked in registry.
- Mongo driver 7.7.0, Redis client 6.3.0, amqplib 2.2.0 (own types, no stale @types/amqplib); Zod 4.6.7; Vitest 5.0.4.
- Pino 10.4.0; **@prometheus-io/client 0.16.1** replaces deprecated prom-client per registry notice and official project docs; OTel API 1.9.1 is a no-op tracing seam until exporter/SDK instrumentation in Phase 08. https://github.com/prometheus/client_js ; https://opentelemetry.io/docs/languages/js/

| Development image tag | Reference / verification limit |
| --- | --- |
| mongo:8.0.32 | Mongo major stable branch released Sept 11 2026 per https://www.mongodb.com/docs/manual/release-notes/8.0/ |
| redis:8.10.2-alpine | https://github.com/redis/redis/releases/tag/8.10.2 |
| rabbitmq:4.3.6-management-alpine | https://github.com/rabbitmq/rabbitmq-server/releases/tag/v4.3.6 |
| dxflrs/garage:v2.4.1 | Official downloadable image and automatic single-node setup https://garagehq.deuxfleurs.fr/documentation/quick-start/ ; AGPLv3 https://github.com/deuxfleurs-org/garage |
| axllent/mailpit:v1.31.5 | https://github.com/axllent/mailpit/releases/tag/v1.31.5 |
| livekit/livekit-server:v1.13.9 | https://github.com/livekit/livekit/releases/tag/v1.13.9 |
| clamav/clamav:1.5.4 | https://github.com/Cisco-Talos/clamav/releases/tag/clamav-1.5.4 |

All image tags pinned, not `latest`. Baseline Mongo/Redis/Rabbit/Garage/Mailpit images were pulled and health-tested, and their observed SHA256 digests now also pin Compose; recreation with retained volumes was verified. Optional media/scanner tags have only Compose syntax validation, no runtime validation yet. Production promotion must verify target-architecture image digests, scan images and review upstream licenses. The single-node local store's AGPL source/distribution is reviewed; application uses an S3 adapter boundary, no vendor code copied. Local services do not imply production licensing, redundancy or capacity validation. No paid account needed.

GitHub CI actions pin exact official tag commits fetched from GitHub API: checkout v7.0.1 (`3d3c42e5aac5ba805825da76410c181273ba90b1`), setup-node v7.1.0 (`949feb2413d6458794dcd2491c4babbbce0c15c1`). CI execution remains unverified until run remotely.


Phase 01 verified pins: argon2 0.45.1, @fastify/cookie 11.1.3 (Fastify 5.12.5 compatibility retained), nodemailer 10.1.0, @types/nodemailer 8.0.2, @playwright/test 1.64.0. Matching Chromium build 1248 / Chrome for Testing 156.0.8078.4 ran locally. Explicit Argon2 native allowlist added. Benchmark, official references, integration/browser evidence and remaining limits: [Phase 01](../phase-01-evidence.md).

Phase 06 verified registry pins (2026-10-17): web-push 3.6.7 (MPL-2.0), @types/web-push 3.6.4. Native browser Push API/service worker; no frontend secret or additional service provider dependency. See [safety runbook](../runbooks/safety.md) for official references and provider verification limits.


Phase 07 (2026-10-18): pinned livekit-client 2.23.0 and livekit-server-sdk 2.19.1 from the registry after official API review. Client transitive machina 7.0.1 requires Node >=22.22.0, so root engines now require ^22.22.0 or ^24.0.0. Local verification uses npm integrity-pinned node-win-x64 24.21.0 in ignored .cache/node24; no global runtime change. The earlier Node 22.15 compatibility statement is superseded. LiveKit 1.13.9 was pulled, started and digest-pinned to sha256:d0c04791bf63ca8dcea123571827d56ba9504bd57c8d5de60ee03b5408cc3154; this supersedes its earlier syntax-only status. See Phase 07 evidence for runtime test scope; patch-update/OS scanning review remains an operations gate.
