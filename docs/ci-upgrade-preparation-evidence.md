# Upgrade preparation CI correction - 2026-10-20

The supplied GitHub Actions log fails in `beforeAll` while installing actual prior release `f4396e3`: pnpm's forced offline install lacks full registry metadata for `@oxc-project/types`. All seven cases are skipped after the setup error; this is not a failed upgrade compatibility assertion. A current-release frozen install does not guarantee metadata for the historical lockfile's policy/peer contexts.

Removed only `--offline` from prior preparation. The normal configured registry may supply missing packages/metadata; frozen lockfile, cache reuse, historical engine/build/release-age/peer policy, exact Git source, artifact hashes and refusal guards remain. No historical lockfile, application source, migration, dependency version or workflow gate was changed by this correction. Existing uncommitted 09A/09B work is preserved. Runbook's old offline-cache assumption is corrected.

Actual cold-metadata probe: fresh owned ignored source directory `.cache/ucf-hlXYiW`, exact prior Git archive, empty metadata/state directories and the existing content-addressed package store. The old offline command reproduced `ERR_PNPM_NO_OFFLINE_META`. The normal frozen install succeeded and prior API/dependency build passed, without modifying historical lock/policy bytes. This is a cold registry-metadata reproduction on Windows, not a completely empty package store or a rerun of hosted Linux CI.

- Prior commit: `f4396e3782b57050d62561ac0dab8a0a844f4bc5`.
- Historical lock SHA256: `50a34c7830b6565c39371d64430a2382653ee4b58e1b8aba95917f3b76fb04cc`.
- Historical workspace-policy SHA256: `25eb7b778a8363fffbc0e656be26642ae992ccbbce16347f04934fca9b0eb330`.
- Rebuilt domain/API SHA256: `355fd762f323d225f9c3f34829a8acd2dc4c9a96767507a21c51efcfe54d9898` / `e6df52b054a2ca4d9d365d1f9f81f650f57811c8fc7615a786388680b42a8df1`, matching the existing provenance-checked prior artifact.

Private probe scripts/logs/result: `.cache/upgrade-ci-fix-6fa2/`. The Windows empty-metadata probe first lacks `@bufbuild/protobuf`; the supplied Linux run first lacks `@oxc-project/types`. Both demonstrate the same offline metadata requirement, not a defect specific to either dependency.

**Verified locally:** all workspace/tools typechecks and lint/import boundaries passed; `pnpm test:upgrade` **7 passed / 114.44s**, with no skipped cases. This full real-service regression uses the existing provenance-checked prior artifact, whose compiled hashes match the independent cold build above. Neither the historical policies nor the compatibility/lease/crash assertions were weakened. No hosted Linux CI rerun is claimed.

Final preservation passed: both original users, all nine migration markers and all 40 earlier ordinary collections match the 09B checkpoint/baseline. Zero fixture databases or original-provider rooms; original eight dependency containers healthy and authenticated LiveKit available. Checked task listeners and upgrade verification processes are absent. One slow read-only collection check completed successfully; its redundant direct-Node check also completed with the same match. All verification sessions have exited. Cold source/build/log caches remain ignored for inspection; no ordinary data/cache reset, service recreation, commit or push was performed. Whitespace, Markdown links, original brief and applied migration checks passed. Resume Phase 09C from the existing plan; this CI correction is locally complete.
