import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { upgradeMediaFixture } from '../tests/integration/upgrade-media.js';
const fixture = await upgradeMediaFixture({ webhookPort: 3000, turn: true });
try {
  const child = spawn(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test', '--config', 'tests/e2e/calls-relay.config.ts'], { windowsHide: true, stdio: 'inherit', env: { ...process.env, ...fixture.env } });
  process.exitCode = await new Promise<number>(done => { child.once('error', () => done(1)); child.once('exit', code => done(code ?? 1)); });
} finally { await fixture.close(); }
