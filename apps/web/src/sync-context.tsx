import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import type { AuthSession } from '@chat/contracts';
import { clearAccount } from './auth-state.js';
import { SyncEngine } from './sync-engine.js';
const Context = createContext<SyncEngine | null>(null);
export function SyncProvider({ account, children }: { account: AuthSession; children: ReactNode }) {
  const [engine, setEngine] = useState<SyncEngine | null>(null);
  useEffect(() => { const current = new SyncEngine(account, clearAccount); setEngine(current); current.start(); return () => current.stop(); }, [account.user.id, account.sessionId, account.csrfToken]);
  return engine && engine.account.user.id === account.user.id && engine.account.sessionId === account.sessionId ? <Context.Provider value={engine}>{children}</Context.Provider> : <p role="status">Opening secure sync…</p>;
}
export function useSyncEngine() { const engine = useContext(Context); if (!engine) throw new Error('Sync context is unavailable'); useSyncExternalStore(engine.subscribeState, () => engine.version); return engine; }
export function SyncStatus() { const engine = useSyncEngine(); return <p className="hint" role="status">{engine.connected ? 'Live connection' : 'Reconnecting · durable history remains available'} · {engine.durable ? 'Pending commands saved on this device' : 'Storage unavailable: pending commands stay only in this page'}</p>; }
