import { useState } from 'react';
import type { AuthSession, Conversation } from '@chat/contracts';
import { useNavigate } from 'react-router-dom';
import { api } from './api.js';
import { queryClient } from './auth-state.js';
import { useSyncEngine } from './sync-context.js';
import { Modal } from './dialog.js';

type Action = 'clear' | 'delete' | 'delete-group';
const titles: Record<Action, string> = { clear: 'Clear chat history', delete: 'Delete chat', 'delete-group': 'Delete group' };
const descriptions: Record<Action, string> = {
  clear: 'Remove earlier messages and files from your view on all your devices. Other members keep their history. New messages will still appear. This cannot be undone.',
  delete: 'Clear earlier history for you and remove this direct chat from your list. The other person keeps their messages. A new message or opening this contact again brings the chat back.',
  'delete-group': 'Delete this group for every member. Everyone loses access to its messages and files, invitations are cancelled and calls end. This cannot be undone.'
};
export function ConversationActions({ conversation: c, account, onClear }: { conversation: Conversation; account: AuthSession; onClear: () => void }) {
  const [selected, setSelected] = useState<{ action: Action; key: string } | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const engine = useSyncEngine(), navigate = useNavigate();
  const pending = engine.pending.some(row => row.conversationId === c.id && (row.command.type === 'send' || row.command.body.kind !== 'receipt'));
  async function confirm() {
    if (!selected || busy) return; setBusy(true); setError('');
    try {
      await api(`/conversations/${c.id}/actions`, { method: 'POST', csrf: account.csrfToken, body: { action: selected.action, commandId: selected.key } });
      if (selected.action === 'clear') { onClear(); await engine.synchronize(c.id); setNotice('Chat history cleared for you.'); }
      else navigate('/chat', { replace: true });
      await queryClient.invalidateQueries({ queryKey: ['chat', account.user.id] }); setSelected(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not complete this action.'); } finally { setBusy(false); }
  }
  const open = (action: Action) => { setError(''); setNotice(''); setSelected({ action, key: crypto.randomUUID() }); };
  return <section className="chat-section conversation-actions" aria-label="Chat management"><h3>Manage conversation</h3>
    <button className="button-secondary" onClick={() => open('clear')}>Clear chat history</button>
    {c.kind === 'direct' && <button className="button-secondary danger-button" onClick={() => open('delete')}>Delete chat</button>}
    {c.kind === 'group' && c.role === 'owner' && <button className="button-secondary danger-button" onClick={() => open('delete-group')}>Delete group</button>}
    {notice && <p className="notice" role="status">{notice}</p>}
    {selected && <Modal title={titles[selected.action]} close={() => { if (!busy) setSelected(null); }}><p className="dialog-description">{descriptions[selected.action]}</p>{pending && <p className="notice" role="status">Wait for pending messages and actions to finish, or review them in the composer first.</p>}{error && <p role="alert" className="notice error">{error}</p>}<div className="dialog-actions"><button className="button-secondary" disabled={busy} onClick={() => setSelected(null)}>Cancel</button><button className="danger-button" disabled={busy || pending} onClick={() => { void confirm(); }}>{busy ? 'Saving…' : `Confirm ${titles[selected.action].toLowerCase()}`}</button></div></Modal>}
  </section>;
}
