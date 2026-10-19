import { loadConfig } from '@chat/config';
import { randomUUID } from 'node:crypto';
import { capturePolicy, captureSnapshot } from './recovery/capture.js';
import { restoreSnapshot } from './recovery/restore.js';
import { recoveryKey, RecoveryError } from './recovery/bundle.js';
const [operation, first, second, third] = process.argv.slice(2);
let restoreTarget: string | undefined;
try {
  const config = loadConfig(), key = recoveryKey();
  if (operation === 'backup' && first && !second) { const result = await captureSnapshot(config, first, key); console.log(JSON.stringify({ kind: result.kind, id: result.id, capturedAt: result.capturedAt })); }
  else if (operation === 'policy' && first && second && !third) { const result = await capturePolicy(config, first, second, key); console.log(JSON.stringify({ kind: result.kind, id: result.id, capturedAt: result.capturedAt })); }
  else if (operation === 'restore' && first && second) {
    const target = third ?? `restore_${randomUUID().replaceAll('-', '')}`;
    if (/^restore_[a-f0-9]{32}$/.test(target)) restoreTarget = target;
    console.log(JSON.stringify(await restoreSnapshot(config, first, second, key, target)));
  }
  else throw new RecoveryError('Usage: recovery.ts backup <file> | policy <snapshot> <file> | restore <snapshot> <policy> [fresh-target]');
} catch (error) { console.error(error instanceof RecoveryError ? error.message : 'Recovery failed; inspect private state and retry into a fresh namespace.'); if (restoreTarget) console.error(JSON.stringify({ target: restoreTarget, operationFailed: true })); process.exitCode = 1; }
