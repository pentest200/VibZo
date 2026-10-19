import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { upgradeMediaFixture } from '../tests/integration/upgrade-media.js';

// Reuse the actual loopback-only, label-checked provider/mail lifecycle.
// This journey does not depend on the original development SFU webhook route.
const fixture = await upgradeMediaFixture();
try {
  const child = spawn(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test', '--config', 'tests/e2e/journey.config.ts', ...process.argv.slice(2)], { windowsHide: true, stdio: 'inherit', env: { ...process.env, ...fixture.env } });
  process.exitCode = await new Promise<number>(done => { child.once('error', () => done(1)); child.once('exit', code => done(code ?? 1)); });
} finally { await fixture.close(); }
