import { createECDH, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const key = createECDH('prime256v1'); key.generateKeys();
await mkdir('.cache', { recursive: true });
// Exclusive creation preserves the VAPID identity across reruns; no secret is printed.
await writeFile('.cache/push.env', [
  'PUSH_ENABLED=true', `VAPID_PUBLIC_KEY=${key.getPublicKey().toString('base64url')}`,
  `VAPID_PRIVATE_KEY=${key.getPrivateKey().toString('base64url')}`,
  'VAPID_SUBJECT=mailto:accounts@commonroom.example.test', `PUSH_ENCRYPTION_KEY=${randomBytes(48).toString('base64url')}`, ''
].join('\n'), { flag: 'wx', mode: 0o600 });
console.log('Created ignored .cache/push.env. Load it explicitly in API and worker processes. Set a real contact before using public push services.');
