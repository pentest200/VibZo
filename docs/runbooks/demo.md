# Local integrated demo

The executable demo is `pnpm test:e2e:journey`. It uses the actual browser, API, gateway, worker, Mongo, Redis, RabbitMQ, private storage, ClamAV and image processor. It provisions its own labelled LiveKit/Mailpit pair, verified synthetic accounts and owned database/object/broker namespaces. Generated native audio/video and screen capture exercise real WebRTC; they do not demonstrate physical devices, TURN or remote-network reliability.

Build first and start the normal baseline and scanner using the [README setup](../../README.md#local-setup). Install pinned Chromium into `.cache/ms-playwright` using the README command. Stop application dev processes on 3000/3001/3002/5173; preserve dependency containers and data. Then:

```powershell
pnpm.cmd build
pnpm.cmd test:e2e:journey
```

For a visible demo, append `--headed`; this option is available but its presentation behavior is not separately verified. Linux/macOS use `pnpm` in place of `pnpm.cmd`. The test has a 300s case deadline, one worker and no automatic retries. An unsuccessful case remains a failure even if cleanup succeeds. Screenshots/traces under `.cache/journey-results` are private synthetic-test diagnostics; do not publish raw logs, tokens, email links, SDP or provider configuration.

Follow these checkpoints in the browser test or use them as a short manual walkthrough with two independently verified development accounts:

1. Sign in separately, find the other account and open a direct conversation. Send, reply and edit; the other browser receives the canonical changes. Like and explicitly mark messages read.
2. Disconnect the second browser's actual network using browser offline mode. Make a local reaction/read change while the first browser edits a message. Reconnect: authoritative replay and the persisted queue converge. Separately abort the first browser's send requests, queue a message and reload. Restore requests: the recipient sees one message and retries retain one client command ID. This is the demo's actual network failure/recovery, scoped to those browser requests.
3. Upload a small text file, wait for actual safety checks, send it and download as the other member. Compare bytes. Upload a PNG avatar in Account, wait for scanning/processing, publish, observe self-only privacy, then explicitly enable sharing and observe it as the contact.
4. Start and accept a video call. Confirm both browsers decode remote frames and audio counters grow; mute/unmute and share/stop the screen. End for everyone and confirm remote tracks disappear. Automated generated media avoids asking the operator for real device access.
5. Create a group, invite/accept, grant admin, send and remove the other member. Confirm removal revokes the conversation view. Report a message, remove it through the test moderator, block/unblock a contact, then exercise account deletion. The automated moderator assignment is confined to the owned test database; it is not a product self-promotion action.

After the executable demo, server teardown precedes ownership-checked fixture cleanup. Provider containers/configuration are removed by the wrapper. Inspect a failed cleanup using [the lifecycle guidance](../../README.md#local-setup); never delete an unfamiliar namespace by prefix. A manual demo retains its own accounts/messages until explicitly removed and is not automatically cleaned.

The standalone `test:e2e:journey` demo reuses the existing baseline/scanner. `test:setup:full` now executes this same journey within a full fresh isolated setup, including browser installation, scanner/decoder and owned media/mail. That separate command passed; its loopback webhook delivery was also observed. See the [setup procedure](setup-rehearsal.md) and [09D evidence](../phase-09d-evidence.md) for exact scope. Physical devices, remote networks and production provisioning remain independent.
