# Mongo infrastructure startup CI correction

Status: startup hardening verified locally; hosted Linux CI rerun and the exact hosted failure cause remain unconfirmed. No product phase advanced.

The supplied `infra:up` log shows four baseline services healthy and Mongo unhealthy. It omits Mongo's health history and server logs. The previous wrapper then misleadingly suggested that the Docker engine might not be running. An unchanged, fresh-volume control using the exact pinned Mongo image/probe passed locally, so the original CI failure was not reproduced on an ordinary cold start.

## Observed failure mechanism and change

A separate fresh fixture limited to 0.1 CPU reproduced repeated shell-probe starvation. During its 75s observation window, the old probe never became ready; the last five health entries all had exit code -1 and `Health check exceeded timeout (5s)`. The container was running and not OOM-killed. Its Docker health status was still `starting` when the bounded observation ended; this is evidence of the timeout mechanism, not an exact reproduction of the supplied hosted `unhealthy` result.

The corrected probe passed at the same CPU limit with a fresh volume. Its first invocation took 15.65s and correctly returned not-ready while initialization/election completed; the next took 8.90s and passed. Both exceed the previous 5s probe limit. These are controlled CPU-throttling observations, not production capacity measurements or proof of the hosted runner's resource state.

Changes:

- Give `mongosh` a 20s probe budget, retaining `infra:up`'s 240s overall wait, 5s interval, 30 retries and 10s start period.
- Use an explicit IPv4 loopback, direct Mongo connection with 2s connection/selection bounds and `--norc`. Suppress the unnecessary full `rs.status()` result.
- Initialize only an uninitialized replica set (named error or numeric code 94), check initialization success, and require both `setName === rs0` and writable primary status. Existing configurations are not reconfigured or reset. A writable standalone still fails.
- On startup failure, report bounded Compose-owned container state, OOM/exit information and Docker health history before rethrowing the original error. Inspection failure cannot replace the original startup error. The diagnostics exclude container environment and Docker credential configuration. `pnpm exec tsx scripts/infra.ts diagnose` is also available independently.
- CI runs the isolated startup regression before baseline startup and collects state/health diagnostics on later failures, before existing service logs and volume-preserving teardown.

## Verification

| Check | Result |
| --- | --- |
| Unchanged cold pinned-image control, 1 CPU / 1 GiB | Healthy; owned container/network/volume removed |
| Old probe, fresh volume, 0.1 CPU / 1 GiB | Failed 75s observation; repeated actual 5s health timeouts; no OOM |
| Corrected probe, fresh volume, 0.1 CPU / 1 GiB | Healthy; observed 15.65s not-ready and 8.90s successful probes; owned cleanup passed |
| `pnpm infra:config` | Passed, all Compose profiles |
| `pnpm test:integration:infra` | 1 integrated real-service regression passed, 30.75s |
| Tools TypeScript check and `pnpm lint` | Passed, including new scripts/tests and import boundaries |
| `pnpm test:integration:foundation` | 6 real-service checks passed, 9.09s |
| Original-data preservation | 2 users, 9 markers, all 40 original collection fingerprints unchanged; zero fixture databases/original-provider rooms |

The new regression uses a uniquely labeled, no-published-port Compose project with a fresh 1 GiB / 1 CPU Mongo fixture. It proves cold initialization, actual majority-journaled two-collection commit/abort, restart with unchanged replica configuration and retained committed documents, rejection of a running writable standalone, and actual failed-health diagnostic output without an environment dump. Cleanup verifies ownership labels before removing only that project's container, network and test volume. It does not recreate the ordinary development Mongo container or alter its volume.

Private evidence: `.cache/ci-mongo-fe4f3a7f6f7c/` (unchanged control), `.cache/ci-mongo-59ab3ec5cec1/` (old throttled failure), `.cache/ci-mongo-e52a38efebe9/` (corrected throttled success), `.cache/infra-startup-72cccc1e25af/` (integrated regression), `.cache/ci-mongo-foundation.log` (foundation checks). Failed attempts remain retained. Owned fixtures were removed; original containers/data/volumes remain intact. No dependency/image pin, lockfile, applied migration, user data, public deployment or remote workflow was changed by these checks.

The supplied hosted failure could also have another cause. If its next run fails, use the newly captured health exit/output and OOM/process state to diagnose it; do not assume every Mongo startup failure is probe starvation or remove volumes to troubleshoot. Phase 09C's media 503 and larger-load limitations remain separate and unresolved.
