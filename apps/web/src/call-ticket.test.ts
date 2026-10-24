import { afterEach, expect, it, vi } from 'vitest';
import { waitForCallTicket } from './call-ticket.js';
afterEach(() => { vi.useRealTimers(); });
it('issues immediately when no cooldown is outstanding', async () => {
  const waiting = vi.fn(); expect(await waitForCallTicket(() => 0, () => true, waiting)).toBe(true); expect(waiting).not.toHaveBeenCalled();
});
it('does not issue early when a slow acknowledgement extends a wait already in progress', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0); let next = 5100, issued = false;
  const promise = waitForCallTicket(() => next, () => true, () => {}).then(result => { issued = result; });
  await vi.advanceTimersByTimeAsync(3000); next = Date.now() + 5100; // Prior request finally acknowledges.
  await vi.advanceTimersByTimeAsync(2100); expect(issued).toBe(false); // The stale first deadline is insufficient.
  await vi.advanceTimersByTimeAsync(2999); expect(issued).toBe(false);
  await vi.advanceTimersByTimeAsync(1); await promise; expect(issued).toBe(true);
});
it('cancels a stopped media effect without issuing its scheduled request', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0); let active = true;
  const promise = waitForCallTicket(() => 5100, () => active, () => {}); active = false;
  await vi.advanceTimersByTimeAsync(5100); expect(await promise).toBe(false);
});
