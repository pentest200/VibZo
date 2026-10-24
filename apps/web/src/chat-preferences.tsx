import { useState } from 'react';
import type { AuthSession } from '@chat/contracts';
import { api } from './api.js';
import { queryClient } from './auth-state.js';
import { useSyncEngine } from './sync-context.js';
import { Icon } from './ui.js';
export function ChatPreferences({ id, pinned, archived, account }: { id: string; pinned: boolean; archived: boolean; account: AuthSession }) {
  const engine = useSyncEngine(), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [retry, setRetry] = useState<{ kind: 'pin-chat' | 'archive-chat'; active: boolean; commandId: string } | null>(null);
  async function apply(kind: 'pin-chat' | 'archive-chat', active: boolean) {
    const input = retry?.kind === kind && retry.active === active ? retry : { commandId: crypto.randomUUID(), kind, active };
    setRetry(input); setBusy(true); setError('');
    try { await api(`/conversations/${id}/preferences`, { method: 'PATCH', csrf: account.csrfToken, body: input }); setRetry(null); await engine.refreshInbox(); await queryClient.invalidateQueries({ queryKey: ['chat', account.user.id, 'detail', id] }); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not update this chat.'); } finally { setBusy(false); }
  }
  return <div className="chat-preferences"><button type="button" className="button-secondary" disabled={busy} onClick={() => { void apply('pin-chat', !pinned); }}><Icon name="pin" size={17} />{pinned ? 'Unpin chat' : 'Pin chat'}</button><button type="button" className="button-secondary" disabled={busy} onClick={() => { void apply('archive-chat', !archived); }}><Icon name="archive" size={17} />{archived ? 'Unarchive chat' : 'Archive chat'}</button>{error && <p className="notice error" role="alert">{error}</p>}</div>;
}
