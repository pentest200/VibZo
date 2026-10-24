import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { upgradeMediaFixture } from '../tests/integration/upgrade-media.js';
import { browserEndpoints } from '../tests/e2e/endpoints.js';
// Preserve the ordinary provider path in existing local/CI gates. A guarded
// isolated-port run needs its own provider with a matching callback listener.
const fixture = process.env['E2E_SETUP_PORTS'] ? await upgradeMediaFixture({ webhookPort: browserEndpoints().api }) : null;
try {
  const child = spawn(process.execPath, [resolve('node_modules/@playwright/test/cli.js'), 'test', '--config', 'tests/e2e/calls.config.ts', ...process.argv.slice(2)], { windowsHide: true, stdio: 'inherit', env: { ...process.env, ...fixture?.env } });
  process.exitCode = await new Promise<number>(done => { child.once('error', () => done(1)); child.once('exit', code => done(code ?? 1)); });
} finally { await fixture?.close(); }
