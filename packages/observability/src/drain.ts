import { setTimeout as delay } from 'node:timers/promises';

// Count independently of socket membership: disconnecting must not hide owned work.
export class DrainTracker {
  active = 0;
  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.active++;
    try { return await operation(); } finally { this.active--; }
  }
  async idle(timeout: number) {
    const deadline = Date.now() + timeout;
    while (this.active) {
      if (Date.now() >= deadline) throw new Error('Drain deadline exceeded');
      await delay(10);
    }
  }
}
