/** Recheck after each wait: a slow in-flight response can extend the issuance deadline. */
export async function waitForCallTicket(nextAt: () => number, active: () => boolean, waiting: () => void) {
  while (active()) {
    const delay = nextAt() - Date.now();
    if (delay <= 0) return true;
    waiting(); await new Promise<void>(resolve => setTimeout(resolve, delay));
  }
  return false;
}
