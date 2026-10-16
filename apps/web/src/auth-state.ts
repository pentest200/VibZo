import { QueryClient, useQuery } from '@tanstack/react-query';
import { currentSession } from './api.js';
import { clearPrivateStore } from './sync-db.js';
export const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
export const accountKey = ['account-session'];
export function useAccount() { return useQuery({ queryKey: accountKey, queryFn: currentSession, refetchInterval: 30000 }); }
function resetAccountCache() {
  void clearPrivateStore();
  queryClient.setQueryData(accountKey, null);
  queryClient.removeQueries({ predicate: query => query.queryKey[0] !== 'account-session' });
  void queryClient.invalidateQueries({ queryKey: accountKey });
}
export function clearAccount() { resetAccountCache(); channel?.postMessage({ kind: 'account-changed' }); }
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('commonroom-account') : null;
channel?.addEventListener('message', event => { if (event.data?.kind === 'account-changed') resetAccountCache(); });
