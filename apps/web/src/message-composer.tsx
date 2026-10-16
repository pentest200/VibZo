import { useState } from 'react';
import type { FormEvent } from 'react';
import { acceptedMessageSchema, sendMessageSchema } from '@chat/contracts';
import type { AuthSession } from '@chat/contracts';
import { api } from './api.js';
import { queryClient } from './auth-state.js';
export interface ReplyTarget { id: string; text: string }
export function MessageComposer({ id, account, reply, clearReply }: { id: string; account: AuthSession; reply: ReplyTarget | null; clearReply: () => void }) {
  const [text, setText] = useState(''), [clientMessageId, setId] = useState(() => crypto.randomUUID());
  const [attempted, setAttempted] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [pendingReply, setPendingReply] = useState<string | undefined>();
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setError(''); setNotice('');
    const replyToId = attempted ? pendingReply : reply?.id;
    const input = sendMessageSchema.safeParse({ v: 1, conversationId: id, clientMessageId, text, ...(replyToId ? { replyToId } : {}) });
    if (!input.success) { setError('Write 1–4,000 characters before sending.'); return; }
    setBusy(true); setAttempted(true); setPendingReply(replyToId);
    try {
      acceptedMessageSchema.parse(await api('/messages', { method: 'POST', body: input.data, csrf: account.csrfToken }));
      setText(''); setId(crypto.randomUUID()); setAttempted(false); setPendingReply(undefined); clearReply();
      setNotice('Accepted by the server. Delivery and read status are not available yet.');
      await queryClient.invalidateQueries({ queryKey: ['chat', account.user.id, 'history', id] });
    } catch (failure) { setError(`${failure instanceof Error ? failure.message : 'The result is unconfirmed.'} Retry keeps the same message ID. Check history before discarding.`); }
    finally { setBusy(false); }
  }
  function discard() {
    if (attempted && !window.confirm('A previous attempt may already be accepted. Check history before discarding this draft.')) return;
    setText(''); setAttempted(false); setId(crypto.randomUUID()); setPendingReply(undefined); setError(''); clearReply();
  }
  return <section className="chat-section composer" aria-label="Write a message"><form onSubmit={event => { void submit(event); }}>
    {reply && !attempted && <div className="reply-preview"><p>Replying to: {reply.text.slice(0, 120)}</p><button type="button" className="button-secondary" onClick={clearReply}>Cancel reply</button></div>}
    {attempted && pendingReply && <p className="hint">This attempt includes your selected reply.</p>}
    <label className="field">Message<textarea name="message" rows={3} maxLength={8000} value={text} readOnly={attempted} onChange={event => setText(event.target.value)} placeholder="Write something…" /></label>
    {error && <p role="alert" className="notice error">{error}</p>}<p role="status" className="notice">{notice}</p>
    <div className="control-row"><button disabled={busy || !text.trim()}>{busy ? 'Sending…' : attempted ? 'Retry message' : 'Send message'}</button><button type="button" className="button-secondary" disabled={busy} onClick={discard}>Discard draft</button></div>
    <p className="hint">Drafts and retries stay in this page only. Refreshing or leaving can discard them. History checks for updates every 5 seconds.</p>
  </form></section>;
}
