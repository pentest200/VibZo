import { createContext, lazy, Suspense, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { callListSchema, callSchema, callStatusSchema } from '@chat/contracts';
import type { AuthSession, CallView } from '@chat/contracts';
import { api } from './api.js';
import { Icon } from './ui.js';

const CallMedia = lazy(() => import('./call-media.js'));

interface CallUI { account: AuthSession; id: string | null; select: (id: string, join?: boolean) => void; joinWanted: boolean; expanded: boolean; minimize: () => void; stop: () => void; dismiss: () => void }
const Context = createContext<CallUI | null>(null);
function useCalls() { const value = useContext(Context); if (!value) throw new Error('Call controls unavailable'); return value; }
export function CallUIProvider({ account, children }: { account: AuthSession; children: ReactNode }) {
  const [id, setId] = useState<string | null>(null), [joinWanted, setJoinWanted] = useState(false), [expanded, setExpanded] = useState(true);
  return <Context.Provider value={{ account, id, joinWanted, expanded, minimize: () => setExpanded(false), select: (next, join) => { setJoinWanted(previous => join ?? (next === id && previous)); setId(next); setExpanded(true); }, stop: () => setJoinWanted(false), dismiss: () => { setId(null); setJoinWanted(false); } }}>{children}</Context.Provider>;
}
function useCallStatus(account: AuthSession) { return useQuery({ queryKey: ['call-status', account.user.id], queryFn: async () => callStatusSchema.parse(await api('/calls/status')), refetchInterval: 15000, retry: false }); }
function callMutation(account: AuthSession, id: string, action: string, targetUserId?: string) { return api(`/calls/${id}/actions`, { method: 'POST', csrf: account.csrfToken, body: { commandId: crypto.randomUUID(), action, ...(targetUserId ? { targetUserId } : {}) } }); }
export function CallLauncher({ conversationId, blocked }: { conversationId: string; blocked: boolean }) {
  const ui = useCalls(), status = useCallStatus(ui.account), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const keys = useRef({ voice: crypto.randomUUID(), video: crypto.randomUUID() });
  const history = useQuery({ queryKey: ['calls', ui.account.user.id, conversationId], queryFn: async () => callListSchema.parse(await api(`/calls?conversationId=${conversationId}`)), enabled: !!status.data?.enabled, refetchInterval: 3000 });
  const current = history.data?.find(c => ['ringing', 'active', 'ending'].includes(c.state));
  async function start(mode: 'voice' | 'video') {
    setBusy(true); setError(''); try {
      const result = await api('/calls', { method: 'POST', csrf: ui.account.csrfToken, body: { commandId: keys.current[mode], conversationId, mode } }) as { id: string };
      keys.current[mode] = crypto.randomUUID(); ui.select(result.id, true); await history.refetch();
    } catch (e) { setError(e instanceof Error ? e.message : 'Call could not be started.'); } finally { setBusy(false); }
  }
  return <section className="call-launcher" aria-label="Conversation calls">
    <h3>Calls</h3>{status.isPending ? <p role="status">Checking calling availability…</p> : status.isError || !status.data?.available ? <p className="hint">Calling is currently unavailable. Messaging is still available.</p> : null}
    <div className="control-row">{!current && <><button className="icon-button" aria-label="Voice call" title={status.data?.available ? 'Voice call' : 'Calling is currently unavailable'} disabled={busy || blocked || !status.data?.available} onClick={() => { void start('voice'); }}><Icon name="phone" size={22} /></button><button className="icon-button" aria-label="Video call" title={status.data?.available ? 'Video call' : 'Calling is currently unavailable'} disabled={busy || blocked || !status.data?.available} onClick={() => { void start('video'); }}><Icon name="video" size={23} /></button></>}{current && <button className="button-secondary" onClick={() => ui.select(current.id)}>Open current call</button>}</div>
    {error && <p role="alert">{error}</p>}{history.isError && <p role="alert">Call history unavailable.</p>}
    {!!history.data?.length && <details><summary aria-label="Call history" title="Call history"><Icon name="history" size={21} /><span className="sr-only">Call history</span></summary><ul className="call-history">{history.data.map(call => <li key={call.id}>{call.mode === 'voice' ? 'Voice' : 'Video'} · {call.state.replace('_', ' ')} · {new Date(call.createdAt).toLocaleString()}</li>)}</ul></details>}
  </section>;
}
export function CallDock() {
  const ui = useCalls(), status = useCallStatus(ui.account), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const panel = useRef<HTMLDialogElement>(null), previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const node = panel.current; if (!node || !ui.id) return;
    if (document.activeElement instanceof HTMLElement && !node.contains(document.activeElement)) previousFocus.current = document.activeElement;
    node.close(); if (ui.expanded) node.showModal(); else { node.show(); previousFocus.current?.focus({ preventScroll: true }); }
    return () => { node.close(); };
  }, [ui.id, ui.expanded]);
  const invitations = useQuery({ queryKey: ['call-invitations', ui.account.user.id], queryFn: async () => callListSchema.parse(await api('/calls/invitations')), enabled: !!status.data?.enabled, refetchInterval: 2000, retry: false });
  const detail = useQuery({ queryKey: ['call', ui.account.user.id, ui.id], queryFn: async () => callSchema.parse(await api(`/calls/${ui.id}`)), enabled: !!ui.id, refetchInterval: 1500, retry: false });
  async function action(call: CallView, action: string, target?: string) {
    if (['end', 'cancel', 'leave'].includes(action)) ui.stop();
    setBusy(true); setError(''); try {
      await callMutation(ui.account, call.id, action, target); if (action === 'accept') ui.select(call.id, true);
      // Selection schedules the correct query on the next render. The current
      // observer may still refer to null or to a different ongoing call.
      if (ui.id === call.id) await detail.refetch(); await invitations.refetch();
    } catch (e) { setError(e instanceof Error ? e.message : 'Call action unavailable.'); } finally { setBusy(false); }
  }
  const c = detail.data, me = c?.participants.find(p => p.userId === ui.account.user.id), open = c && ['ringing', 'active'].includes(c.state);
  return <section className="call-dock" aria-label="Calls">
    {invitations.data?.filter(call => call.id !== ui.id && ['ringing', 'active'].includes(call.state)).map(call => {
      const part = call.participants.find(p => p.userId === ui.account.user.id);
      return <div className="incoming-call" key={call.id}><strong>{part?.state === 'invited' ? 'Incoming' : 'Ongoing'} {call.mode} call · {call.title}</strong><div className="control-row"><button disabled={busy} onClick={() => ui.select(call.id)}>Open call</button>{part?.state === 'invited' && <><button disabled={busy} onClick={() => { void action(call, 'accept'); }}>Accept call</button><button className="button-secondary" disabled={busy} onClick={() => { void action(call, 'decline'); }}>Decline call</button></>}</div></div>;
    })}
    {ui.id && createPortal(<dialog ref={panel} className="call-panel" data-expanded={ui.expanded} aria-label="Current call" onCancel={event => { event.preventDefault(); ui.minimize(); }}>
      <div className="call-window-bar"><button className="icon-button" aria-label={ui.expanded ? 'Minimize call' : 'Restore call view'} onClick={() => ui.expanded ? ui.minimize() : ui.select(ui.id!)}><Icon name={ui.expanded ? 'back' : 'video'} /></button><span>{c?.title ?? 'Call'}<small>{c?.mode === 'voice' ? 'Voice call' : 'Video call'}</small></span>{!ui.expanded && <button className="button-secondary" onClick={() => ui.select(ui.id!)}>Expand call</button>}</div>
      <div className="call-window-body">
      {detail.isPending && <p role="status">Opening call…</p>}{detail.isError && <><p role="alert">Call unavailable. Your media has stopped. Reconnect or check your membership.</p><button className="button-secondary" onClick={ui.dismiss}>Close call</button></>}
      {c && !detail.isError && <><div className="section-heading"><h2>{c.title} · {c.mode} call</h2><Link to={`/chat/${c.conversationId}`} onClick={ui.minimize}>Conversation</Link>{!open && c.state !== 'ending' && <button className="button-secondary" onClick={ui.dismiss}>Close call</button>}</div><div className="call-hero" aria-hidden="true"><span>{c.title.slice(0, 1).toUpperCase()}</span></div><p role="status">{c.state === 'ringing' ? 'Calling · waiting for an answer' : c.state === 'ending' ? 'Ending call · waiting for the media service' : c.state.replace('_', ' ')}</p>{c.reason && <p className="hint">{c.reason}</p>}
        {open && !c.ready && <p role="status">Preparing a secure connection. Reconnects may need a moment.</p>}
        {open && me?.state === 'invited' && <div className="control-row"><button disabled={busy} onClick={() => { void action(c, 'accept'); }}>Accept call</button><button disabled={busy} className="button-secondary" onClick={() => { void action(c, 'decline'); }}>Decline call</button></div>}
        {open && me?.state === 'accepted' && !me.currentDevice && <p className="notice">This call was accepted on another device.</p>}
        {open && me?.state === 'accepted' && me.currentDevice && <><Suspense fallback={<p role="status">Loading media controls?</p>}><CallMedia account={ui.account} call={c} wanted={ui.joinWanted} /></Suspense><div className="control-row">{!ui.joinWanted && <button disabled={busy || !c.ready} onClick={() => ui.select(c.id, true)}>Join or rejoin call</button>}<button className="button-secondary" onClick={ui.stop}>Stop media on this device</button><button className="button-secondary" disabled={busy} onClick={() => { void action(c, 'leave'); }}>Leave call</button></div></>}
        {open && c.canEnd && <button disabled={busy} onClick={() => { void action(c, c.state === 'ringing' ? 'cancel' : 'end'); }}>{c.state === 'ringing' ? 'Cancel call' : 'End call for everyone'}</button>}
        {open && !ui.expanded && me?.state === 'accepted' && !c.canEnd && <button className="button-secondary" aria-label="Hang up call" disabled={busy} onClick={() => { void action(c, 'leave'); }}>Hang up</button>}
        <ul className="call-participants">{c.participants.map(part => <li key={part.userId}>{part.displayName}{part.userId === ui.account.user.id ? ' (you)' : ''} · {part.joined ? 'connected' : part.state}{open && c.canRemove && part.userId !== ui.account.user.id && ['accepted', 'invited'].includes(part.state) && <button disabled={busy} className="button-secondary" aria-label={`Remove ${part.displayName} from call`} onClick={() => { void action(c, 'remove', part.userId); }}>Remove from call</button>}</li>)}</ul>
      </>}
      {error && <p className="notice error" role="alert">{error}</p>}</div>
    </dialog>, document.body)}{!ui.id && error && <p className="notice error" role="alert">{error}</p>}
  </section>;
}
