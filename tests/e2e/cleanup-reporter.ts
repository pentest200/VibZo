import type { Reporter } from '@playwright/test/reporter';
import { cleanupFixture, fixtureIdentity } from './lifecycle.js';

// Playwright 1.64 invokes onEnd after task/plugin teardown, including webServer.
// A globalSetup return callback runs before those servers stop and can race writes.
export default class FixtureCleanupReporter implements Reporter {
  printsToStdio() { return false; }
  async onEnd() { await cleanupFixture(fixtureIdentity()); }
}
