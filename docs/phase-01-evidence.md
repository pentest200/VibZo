# Phase 01 evidence — identity and sessions

2026-10-13 (Asia/Calcutta). **Verified in the local scope below.** Phase 02–09 features remain unimplemented/unverified.

Implemented: registration/login/logout, normalized unique email/username, profile/privacy updates, bounded Argon2id hashing, opaque hash-only sessions, session-specific CSRF, exact Origin/JSON checks, runtime validation, device/global revocation, session quota/rotation/authoritative expiry, one-use verification/reset, password-change revocation, shared verified/moderator policy, Mongo validators/index migration, Redis atomic auth limits, encrypted durable SMTP queue/worker, development fixture command and functional web screens with credential-free account invalidation.

| Executed gate | Result |
| --- | --- |
| `pnpm build` | PASS all apps/packages + web production build |
| `pnpm typecheck` | PASS application/tool/unit/integration/browser test sources |
| `pnpm lint` | PASS including browser/server import boundaries |
| `pnpm test` | PASS 35 tests / 5 files |
| `pnpm db:migrate` | PASS local `001_auth`; integration repeats migration idempotently |
| `pnpm test:foundation:http` | PASS 3 real HTTP regression checks |
| `pnpm test:integration:foundation` | PASS 6 baseline-service regression checks after auth integration |
| `pnpm test:integration:auth` | PASS 14 Mongo/Redis/SMTP/Mailpit/HTTP tests |
| `pnpm test:e2e:auth` | PASS 2 actual Chromium tests; full journey 6.5s, mobile/unauthorized test 384ms, suite 17.3s on this run |
| `pnpm auth:benchmark` | PASS; measured values below, not throughput evidence |
| Development seed smoke | PASS with generated process-only password; ordinary local alice_dev/bob_dev users |
| `pnpm audit --prod --audit-level high` | PASS: no known vulnerabilities returned; not complete security proof |

Integration verifies registration/token/encrypted-job commit, duplicate generic responses and DB uniqueness, strict validator rejection, HttpOnly/SameSite and configured Secure `__Host-`/Path/no-Domain flags, missing/forged Origin/CSRF, attacker fields, non-JSON payloads/safe errors, guessed/foreign session IDs, concurrent quota, rotation/revoked/expired rejection, authorized profile/privacy writes and username conflict, generic reset responses, concurrent reset and verification token consumption (one success/one invalid), verification resend invalidating old link, password/global revocation across devices, unavailable-Redis mutation rejection with authenticated reads preserved, atomic rate limits, actual SMTP/Mailpit delivery, expired-lease reclaim, failed provider staying pending and exhausted crash job becoming dead. Applied-migration rerun also preserves a later additive validator, tested against real Mongo. Each run cleans its unique auth_test_* DB.

Real browser journey: register -> Mailpit verification link -> fragment removed -> verify -> login; actual cookie flags/no localStorage keys; profile/name/privacy save; independent context login and device revocation/rejection on reload; same-cookie second-tab logout convergence; reset request -> real Mailpit link -> new password -> reused link rejected; password-change logout/new login; revoke-all logout. Mobile 390x844 redirects unauthorized `/account` to login, hides private panels and has no horizontal overflow. Captured and visually inspected `.cache/qa/auth-account.png` (1280px full-page desktop) and `.cache/qa/auth-mobile.png`; no clipping/overlap in those layouts. This is not a full a11y or browser-matrix audit.

Hash measurement: Windows / Node 22.15.0 / Intel i5-13450HX, 16 logical CPUs, 15.78 GiB RAM. Argon2id m=65536 KiB, t=3, p=1, 32-byte output, concurrency cap 2/API process; theoretical hash-memory budget 128 MiB/process. One warmup, five sequential hashes: 191.75, 173.80, 165.13, 183.05, 171.25 ms. Two-hash batch 184.84 ms; observed RSS 131.88 MiB at report time. Synthetic passwords; repeat on deployment hardware/combined request load. No production throughput/SLO claim.

Registry/official-doc checked pins: argon2 0.45.1, @fastify/cookie 11.1.3 with Fastify 5.12.5, nodemailer 10.1.0 + @types/nodemailer 8.0.2, @playwright/test 1.64.0. Matching Chromium build 1248 / Chrome for Testing 156.0.8078.4 downloaded into workspace cache. Argon2 native build explicitly allowlisted. References: https://raw.githubusercontent.com/ranisalt/node-argon2/master/README.md ; https://github.com/fastify/fastify-cookie ; https://nodemailer.com/smtp ; https://playwright.dev/docs/intro ; https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html ; https://redis.io/docs/latest/commands/eval/

Corrected failures: missing direct Zod dependency/type-only import, test collection generic assuming ObjectId, auth schema pre-handler incorrectly intercepting unknown routes (503 instead of 404), Playwright server cwd defaulting to config directory. First browser journey exposed same-page reset-link reopening retaining success view; fragment-change handling plus clearing the consumed token fixed it, then both tests passed. Redis commands now use bounded queues/deadlines and a shared reconnect promise. Failed runs were not counted as passes.

Unverified/later work: hosted HTTPS/SMTP end-to-end (Secure flags tested only as metadata), remote CI, full a11y/cross-browser/load/security audits, established-connection Redis partition/fault drills, gateway origin/subscription/disconnect behavior, avatars, conversation/block permissions, chat/outbox, attachments, push, calling, retention/restore/alerts and keyring/mixed-release validation. Privacy preferences are stored but presence/search is not yet implemented. Reverse-proxy trust remains disabled pending reviewed production CIDRs.

SMTP acceptance-before-mark crashes can duplicate email; fixed Message-ID is not provider idempotency. Hash-only one-use tokens still ensure one durable reset/verification effect. Ambiguous login commit before cookie delivery may leave an inaccessible session until expiry/revocation/reset. Completed auth-job metadata retention/controlled replay remain Phase 06/08. No Rabbit atomicity claim for this Phase 01 Mongo job path. See docs/runbooks/auth.md.

Local state: `chat` has `001_auth` and two ordinary development fixture accounts from seed smoke. Initial generated password stayed in process memory/hash only; use local reset to choose your own. Verification jobs pending until development worker runs. Five baseline containers remain loopback/healthy with retained volumes. Test API/worker/web processes stopped; test DBs cleaned; synthetic Mailpit messages remain locally. No paid service/public deployment/external provider used.

Resume **Phase 02** from the exact ordered task list in implementation_plan.md; do not re-scaffold or mark the full application complete.
