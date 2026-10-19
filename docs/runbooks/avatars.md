# Private profile avatars

Phase 09A implements avatars on the existing attachment inspection/storage/job/quota pipeline. Executed verification and remaining limits are tracked in [09A evidence](../phase-09a-evidence.md); implementation alone is not a passing gate.

## Setup and rollout

Build current code and stop pre-avatar API/worker processes before `pnpm db:migrate` adds `009_avatars`. Start current API, worker and web with baseline/scanner services. Existing 001-008 files must remain unchanged. An older attachment worker does not understand the new purpose and can retire avatar work; ordinary-message release overlap does not certify processing avatars with that worker or rolling an avatar-enabled workload back to it. Use current fence-aware binaries for restored targets.

Verify email, open `/account`, then **Your avatar**. Choose JPEG/PNG/WebP, wait for **Ready to use**, and choose **Use as avatar**. Uploading does not replace the current image. Sharing defaults off. **Share my avatar with active conversation members** enables authorized contextual display; **Remove current avatar** clears the pointer immediately. Incomplete uploads can be checked, unavailable scan jobs retried, and unused images removed. An ambiguous request needs a refresh/reconciliation; it does not prove failure. Mutation retries within the mounted form retain their command IDs. A lost reservation response can leave an unused candidate, which remains inspectable and expires normally.

Limits: configurable `MAX_AVATAR_BYTES` defaults/hard-caps at 5 MiB for input and normalized output, also bounded by attachment limits/allowlist. Existing isolated decoder enforces 8,388,608 input pixels, four channels, a single page, orientation/metadata removal and a 2048×2048 maximum bounding box without enlargement. Images are reencoded as WebP. Ten nondeleted current/candidate/retiring rows per owner share existing account storage and job admission quotas. Pending/unused candidates expire after 24 hours; the selected active image does not. Rejected/replaced/deleted files remain charged until physical cleanup can safely complete after outstanding upload URLs expire (plus the existing cleanup grace). Never manually clear quota or jobs to create capacity.

## Privacy and authorization

The owner can request their current approved image. A different verified viewer needs a supplied currently active conversation with active memberships for both parties, an active verified owner, explicit sharing and an unblocked pair, including within groups. Search discovery, invitation and historical membership do not grant avatar reads. Search/blocked/invited displays retain initials. Private shared images appear on active direct inbox entries and selected conversation member displays. Missing/denied/expired/failed images fall back to initials; no unapproved local preview is shown.

Existing public-user DTOs retain the nullable `avatarId` contract but return null, including search/member/blocked projections. Avatar existence and object identity are not advertised through those projections; current contextual grants authorize directly by user ID. Owner-only account/settings responses keep the current avatar ID for replacement and removal.

All profile operations authenticate and serialize on the existing user guard. Contextual reads additionally guard conversation/memberships and the pair, so conflicting removal/block/privacy/deletion transactions are ordered. Avatar publish uses an expected-current-ID comparison and durable per-user command digest: a delayed candidate or retried old publish cannot overwrite a new selection. Avatar-purpose rows cannot be associated/listed/downloaded through message attachment paths. Existing message file policy is unchanged.

GET access to bytes uses an authorized presigned URL, at most `min(DOWNLOAD_URL_SECONDS,30)` seconds, `image/webp`, inline disposition and `private, no-store`. Previously issued bearer URLs can remain usable until expiry, and already-seen pixels/downloads cannot be recalled. The browser holds URLs only in private in-memory query state, refreshes authorization for visible images, expires displayed grants and clears account query state on logout. It does not store URLs/bytes in IndexedDB. Image grants use a separate fail-closed Redis IP budget (`AVATAR_DOWNLOAD_RATE_LIMIT`, default 360 per configured auth rate window), retaining chat/auth mutation capacity. Only visible avatars poll; large/shared-NAT or multi-tab workloads can hit that image budget and show initials.

Deletion immediately clears the avatar pointer/settings and denies fresh grants. The normal resumable attachment cleanup removes bytes and settles quota. Durable command digests/references remain consistent with the existing retry ledger; no original image body is retained in those commands. Safe ledger compaction remains an operations/capacity concern. Recovery accepts exact historical 001-008 or current 001-009 manifests; it explicitly clears restored avatar pointers/sharing and retires avatar assets, requiring fresh upload. The encrypted backup can retain prior images until its retention/key lifecycle expires; this is not cryptographic erasure.

## Validation

```text
pnpm build
pnpm test:integration:avatars
pnpm test:e2e:avatars
pnpm test:integration:attachments
pnpm test:integration:safety
pnpm test:restore
pnpm test:upgrade
pnpm test:integration:e2e-lifecycle
```

Use real scanner/image/storage services and the existing ownership-checked browser lifecycle. Run suites sequentially, keep built files stable during browser tests and use an owned disposable SMTP receiver if required by the recorded local environment. Do not remove unknown fixtures, original mail or development volumes. Phase 09B accessibility/full-feature audit, measured capacity, hardware/other browser certification and earlier native push/TURN/platform gates remain separate.

References checked for this implementation: [OWASP file upload controls](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html), [S3 GET response overrides and signed access](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetObject.html). Actual Garage/ClamAV/decoder behavior must pass the local gates; documentation is not runtime evidence.
