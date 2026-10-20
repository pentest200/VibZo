export interface WindowBoundary { startMs: number; endMs: number; offered?: number }

// Preserve each outcome and drain in-flight work after a sibling fails. The
// caller's stop flag prevents future generation; cleanup must await this result.
export function settleWindows(work: (Promise<WindowBoundary> | undefined)[], stop: () => void) {
  return Promise.allSettled(work.map(async task => {
    try { return await task; } catch (error) { stop(); throw error; }
  }));
}
