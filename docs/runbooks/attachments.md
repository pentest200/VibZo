# Private attachments

Run `pnpm build`, `pnpm infra:up`, `pnpm db:migrate`, `pnpm infra:scanner`, then `pnpm dev`. Baseline infrastructure configures quarantine CORS for the exact `WEB_ORIGIN`; rerun `pnpm attachments:configure` after changing it. Keep 3900 (private S3), 3310 (unauthenticated clamd), and 3003 (authenticated transform proxy) on loopback. Production requires TLS, private service networking, explicit processor credentials, and separate least-privilege storage identities; this Compose configuration is development only. The scanner profile adds a 2 GiB scanner, 512 MiB decoder and 128 MiB proxy, with CPU/PID caps. It does not start LiveKit.

## Upload and authorization

Verified active members reserve one generated quarantine key with an exact byte length, static MIME type, owner/id metadata and a SHA-256 commitment. The command ID is user-scoped and bound to its original input. Signed PUT headers include length, type and metadata; browser-supplied file bytes automatically supply Content-Length. Reservations last at most 15 minutes without extension on retry. Bounds are eight files/message, 25 MiB/file, 1 GiB/account and 100 unused reservations/account. Reserve both source and maximum derivative bytes up front (images reserve an additional 25 MiB; other formats reserve another source length). These are logical live-object/reservation admission bounds, not a physical provider hard quota or a storage-capacity benchmark. Crashed attempts can temporarily leave extra objects until reconciliation; budget orphan space and traffic separately.

Finalization checks current session/member/pair guards, ownership, actual HEAD size/type/metadata and upload deadline. Its Mongo transaction changes pending to uploaded, creates one durable scan job and records the action ID. Accepted means queued for checks, not ready to download. Finalize/retry/delete action IDs are user-scoped; conflicting reuse is rejected. Delete and message association share Mongo writes. Only the owner's ready, unused, unexpired files in the same conversation can enter a message. Association, message, original command digest/result, ordered event and outbox commit together. Duplicate sends return their original reference after reauthorization. Deleting a message changes its attachments to deleting in that same transaction. Existing edits/reactions/receipts remain supported.

```mermaid
sequenceDiagram
  participant B as Browser
  participant A as API + Mongo
  participant Q as Private quarantine
  participant W as Attachment worker
  participant P as ClamAV + isolated decoder
  participant S as Private approved store
  B->>A: Reserve bytes/checksum (deny if unauthorized or quota full)
  A-->>B: Signed PUT, generated key, original expiry
  B->>Q: Exact signed upload (size/type/metadata mismatch denied)
  B->>A: Finalize (HEAD + guarded durable job; retry same action)
  W->>A: Claim with unique owner and server-time lease
  W->>Q: Bounded GET into captured buffer (failure keeps quarantine)
  W->>P: Signature + committed SHA + real scan; isolated image transform
  P-->>W: Clean result or reject/unavailable
  W->>S: New server-only per-claim key; never upload-client writable
  W->>A: Guarded ready + lease/quota commit (lost lease cannot approve)
  B->>A: Poll owned staged state; send only ready IDs
  B->>A: Request download (current authorization + HEAD required)
  A-->>B: Forced-download signed GET, at most 60 seconds
```

Garage has no object versioning. Workers hash and scan the exact captured bytes and upload those captured/derived bytes to a separate key in the approved bucket. ETag and declared Content-Type are not checksum or safety proof. Reusing a still-valid PUT changes only quarantine; it cannot change approved content. Quarantine and approved buckets both reject unsigned access. Do not make either bucket public or enable website hosting. CORS permits only exact-origin PUT and required headers, with no credentials. All signed URLs are bearer credentials: never log, persist in browser storage, or include in analytics.

## Checks, isolation and recovery

State machine: pending → uploaded → processing → ready/rejected; removal/expiry → deleting → deleted. Jobs use Mongo server time, unique owners, 120-second leases, 20-second heartbeat, conditional completion and five total attempts, with exponential retry delay capped at 30 seconds. Crashed final attempts become inspectable failed jobs. The owner can explicitly retry an exhausted uploaded file via `POST /api/v1/attachments/:id/retry` with a new commandId. A dependency failure never becomes a clean result. The worker's attachment loop is independent of email, broker relay and live fanout. Text messaging readiness does not certify scanner/storage health.

Allow JPEG/PNG/WebP, PDF and UTF-8 plain text only. Check signatures, byte count and SHA-256; reject HTML/SVG/archive/spoofed input and unsafe image decode. Never unzip on the app host. PDFs are scanned and forced downloads, with no inline application preview. Text downloads use .txt; PDFs use .pdf; images become .webp. Malware scanning cannot prove harmlessness.

ClamAV 1.5.4 is digest-pinned and uses INSTREAM bytes rather than a host path. It has its own Docker bridge, separate from the database/storage/broker network; outbound signature updates remain allowed. Configuration: 25 MiB input/file, 64 MiB expanded scan, recursion 8, 128 contained files, 20-second scan budget, one scan thread, queue 4, read timeout 30 seconds. Exceeded limits and encrypted containers trigger rejection. The host enforces its own 30-second overall and 3-second connection deadlines. Check `docker compose -f infra/compose/compose.yaml exec -T clamav clamdscan --version` for signature version/date and inspect Freshclam logs regularly; startup health alone does not certify signature freshness. Failed/stale signature maintenance requires operator attention. No scanner bypass is used by this pipeline.

Sharp 0.35.5 executes in a new child for each transform. Only JPEG/PNG/WebP buffer loaders are enabled. Input is capped at 25 MiB, 8,388,608 pixels, four channels, one page/frame; decoding fails on warning. Output strips input metadata, auto-orients, fits 2048×2048 without enlargement and encodes WebP. Limit child JS heap to 128 MiB, libvips processing to ten seconds and entire helper request to twenty seconds. Decoder is non-root with a read-only filesystem, dropped capabilities, no-new-privileges, 64 PIDs, one CPU and 512 MiB cgroup memory. Its internal network has no external route, and its child receives neither processor key nor storage/database credentials. A separate 128 MiB fixed-route streaming proxy bridges host access; it performs no image decode, has no credentials, and accepts only bounded transform requests and health. This extra container preserves decoder isolation on Docker Desktop where an internal-only published port is unreachable. It is not a business service boundary. Production kernel/ASLR/seccomp hardening and resource saturation remain Phase 08/09 gates.

## Downloads and deletion

`POST /api/v1/attachments/:id/download` requires current verified session, CSRF, active membership and an unblocked direct pair. Unused files are owner-only. Message files require a live message and a visibility interval covering its creation sequence: rejoining does not reveal prejoin or absence history. Group blocking keeps the established shared-group policy. Missing/unavailable approved storage returns retryable 503; unknown/unready/foreign/deleting files return 403. Download responses use attachment disposition and private/no-store; grants last at most 60 seconds from signing. Removing/blocking/logging out denies subsequent authoritative requests, but cannot revoke an already issued URL or downloaded bytes. Authorization already overlapping revocation may finish under its earlier grant. Do not promise an immediate cutoff at the storage edge.

Unused uploads/files expire after 24 hours; incomplete pending uploads become deletable after their upload deadline plus a 60-second in-flight grace. Cleanup keeps metadata, jobs and quota reservations until object deletes succeed. It waits for the original upload window plus grace before releasing bytes, skips active claims and releases exactly once in a guarded transaction. For ready files it removes the source and releases only source bytes; for rejected/deleting files it removes source/approved derivatives, clears reserved bytes and marks deleted. Source data is not retained after this cleanup policy.

Each maintenance pass processes at most 20 metadata rows and 50 objects/bucket, rotating prefix pages. Object keys are database-prefixed, so isolated tests never sweep another database's objects. Orphan grace is five minutes in the running worker. Unreferenced approved objects and late uploads are deleted after the grace; ready/current-lease objects are protected using a consistent Mongo snapshot. Crash-after-PUT recovery can leave a temporary orphan; the new claim always uses a different key. Do not TTL-drop metadata before cleanup. Cleanup cadence is best effort (after jobs, normally ten seconds), not a demonstrated deadline under backlog/outage.

Monitor `/metrics`: `chat_attachment_jobs{state="pending|claimed|failed"}` and `chat_attachment_oldest_job_seconds`. Inspect attachment state/error and job attempts/lease without printing keys/URLs/bodies to logs. For stalled jobs, restore scanner/storage/proxy access, inspect signature/processor health and let expired claims recover. For exhausted jobs, use the owner's authenticated retry. Never manually set ready or release quota while objects may still exist. Retention/account deletion/backup reconciliation integrate these records in 06/08; command/tombstone retention has no TTL yet.

## Failure behavior and validation

| Failure | Behavior | Recovery |
| --- | --- | --- |
| Mongo/Redis auth controls unavailable | Protected operations fail closed; no signed grant | Restore dependency and retry original command |
| S3 upload/finalize/read/write unavailable | Reservation/job retained; no ready success | Restore S3, retry upload/finalize or job |
| Scanner/decoder unavailable | Uploaded/processing remains inaccessible; bounded retries | Restore service, exhausted owner retry |
| Rejected signature/hash/malware/pixels | Rejected, cannot attach/download | Remove, choose a valid file |
| Worker exits after approved PUT | Uncommitted object private; lease reclaimed with new key | Reconciliation sweeps old orphan |
| Object cleanup unavailable | Quota retained and deleting remains durable | Restore access; next cleanup repeats safely |
| Browser closes during upload | Source File/progress not persisted; staged server metadata survives | Check an already uploaded file, or remove and select again |

Run `pnpm test:integration:attachments` with baseline and scanner profiles running; run `pnpm test:e2e:attachments` with application ports free. The browser suite uses real independent users, private S3, ClamAV, worker and Chromium. Fault tests modify isolated persisted deadlines/leases and use a one-second orphan grace where stated; they never change machine time. A child actually exits after approved PUT. Storage/scanner outage tests connect to a closed loopback port; they are real connection failures, not full-provider disaster or production network tests. Real external deployment, rolling upgrades, storage IAM role separation, saturation and backup restore remain unverified.
