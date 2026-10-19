# Local release overlap and interrupted-work drills

The supported local drill overlaps exact prior commit `f4396e3782b57050d62561ac0dab8a0a844f4bc5` with the current checkout, using strict v1 commands/events and additive schema 008 on an ordinary disposable database. It does not certify arbitrary versions, destructive down-migrations, production rollout availability or a regional failover. Executed results and failed attempts are in [Phase 08 evidence](../phase-08-evidence.md).

## Run the gates

Use the repository's Node 24/pnpm bootstrap and normal frozen dependency install first. Build current code, start baseline/scanner/media dependencies, then run:

```text
pnpm build
pnpm test:upgrade
pnpm test:e2e:upgrade
```

`test:upgrade` prepares the prior artifact automatically. Git must contain the exact prior commit; CI checks out full history. Preparation uses `git archive` into ignored `.cache/upgrade-artifacts/f4396e3`, an independent frozen install with the normal package policies and existing package/metadata store, and a build of the prior API and dependencies. It never copies current compiled domain files into the old artifact. The offline install fails on a missing package/metadata cache; populate that dependency through the normal trusted installation process rather than disabling policy checks, changing the old lockfile or substituting current dependencies. On a fresh CI checkout the current install provides the shared package cache; the prior release's dependency set is retained by the current lockfile apart from peer-context snapshots.

The preparation marker records full commit, lockfile and compiled entrypoint SHA256 values. Cached entrypoint/lock drift refuses reuse. Declared internal dependencies must resolve inside the selected artifact; the old release does not have the later domain observability dependency. These are local provenance checks in a trusted checkout/cache, not signed artifact attestation or a recursive malicious-cache audit. Incomplete occupied directories without matching source ownership markers are refused. Failed setup directories are retained for inspection, not recursively removed. Short artifact names avoid a Windows native task-state path-length failure observed with the full 40-character hash in the directory name.

`test:upgrade` uses random `upgrade_test_<uuid>` namespaces, synthetic users and IPC inputs. It starts separate old/current Node processes, actual old/current compiled HTTP APIs on loopback, real Rabbit publishers and consumers. It starts with seven prior markers, adds 008, reruns migrations from both artifacts, checks marker identity and unchanged applied migration source bytes, and tests concurrent same-command HTTP acceptance, cross-version retries/conflicts, strict fields and membership authorization. Consumers from both releases apply real durable events; each effect and projection job remains unique.

Test-only IPC barriers hold a process after a real claim, confirmed publication, committed effect before ACK, or actual media room creation. The harness kills the owner and uses the real 30-second database lease deadline: it does not rewrite expiry timestamps. Another artifact recovers the work, and a still-live stale owner cannot complete the new owner's claim. IPC carries only bounded synthetic test inputs; it is not a production control endpoint. Node hard termination on Windows is recorded separately from Linux POSIX signal behavior. The media allocation case creates only its namespace-owned room on the existing local provider and removes that room during cleanup.

## Media interruption and rejoin

`test:e2e:upgrade` provisions a separate pinned LiveKit container and Mailpit receiver, with random runtime credentials and identity labels. Effective HTTP/TCP/UDP bindings are checked to be three loopback-only publications. Provider configuration is ignored, written with requested mode 0600 (Windows inherits workspace ACLs), mounted read-only, and deleted after the fixture is removed. Containers have resource/process limits and cleanup checks their labels before any mutation. Original mail, SFU, volumes and rooms are retained. Provider startup or test failure still runs owned cleanup; a hard kill of the outer launcher can require operator cleanup after proving ownership.

Three browser accounts establish two-party generated audio/video and an unauthorized outsider. The drill sends actual SIGKILL to the disposable Linux SFU, checks exit 137/provider failure and visible media disconnection, restarts it, waits for domain reconciliation to rotate to a new room incarnation, uses the visible rejoin controls, and checks new inbound decoded frames/audio bytes on live peer connections. The outsider's actual HTTP join is denied before and after. Old room absence, one current room and final cleanup are checked. This uses generated Chromium devices with actual WebRTC transport; it does not prove hardware, Safari, forced TURN, or provider webhooks. In particular, it makes no claim to close the separate Phase 07 Linux browser webhook/TURN gates.

Ignored `upgrade-drill-*/evidence.json` records artifact/module identity, migration hashes and observed natural lease wait. `upgrade-media-*/evidence.json` records generations, SFU exit and small-fixture rejoin elapsed time without bearer tokens or media content. These observations include polling/control interaction and do not establish production RTO/capacity or uninterrupted media. Existing provider tokens retain their original bounded validity; `room.auto_create: false` and new incarnations prevent this tested restored provider from silently recreating the absent old room.

## Release and rollback boundaries

For an ordinary additive-schema rollout, keep one database authority, apply only additive migrations, retain dedup/outbox/claim ledgers, start a compatible new binary, verify readiness and authorized command/replay behavior, then drain intake and accepted work before retiring old instances. Current drain handlers are covered separately by operations tests. The prior pre-08A binary lacks those newer drain controls; this drill does not establish a graceful orchestrated shutdown guarantee for it. A lost response still needs the same command ID on retry. Broker confirmation and local effect commits remain separate boundaries.

Rollback here means allowing the tested prior writer/consumer to operate with schema 008 still present. It never removes 008, reverses validators, resets counters, restores old credentials or treats Redis as message authority. Do not roll back to an untested release or compact ledgers during the overlap window. Production routing, budgets, signal propagation and readiness removal require deployment evidence.

**Recovered targets require current fence-aware binaries.** The prior release cannot enforce `restoreControl` and cannot safely handle the deliberately invalidated empty password sentinel. The upgrade harness refuses `restore_*`, development and system targets before spawning either version. A restore is not an ordinary rollout/rollback: follow [recovery](recovery.md), promote only after verification and require fresh credentials. An old binary is not made recovery-safe merely by withholding schema markers.

Do not delete an unfamiliar failed fixture database/container/object prefix. Prove its random namespace, source/run identity and synthetic users first. Current test cleanup validates users, provider room prefixes, broker namespace and Docker labels; it never drops development databases or original volumes. If interrupted, inspect only matching `commonroom.upgrade` labels and ignored evidence privately. A fixture cleanup success is not production backup retention or key-custody proof.
