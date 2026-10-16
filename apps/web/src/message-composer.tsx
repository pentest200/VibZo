import { useState } from 'react';
import type { FormEvent } from 'react';
import { sendMessageSchema } from '@chat/contracts';
import type { AuthSession } from '@chat/contracts';
import { useSyncEngine } from './sync-context.js';
export interface ReplyTarget { id: string; text: string }
export function MessageComposer({ id, reply, clearReply }: { id: string; account: AuthSession; reply: ReplyTarget | null; clearReply: () => void }) {
  const engine = useSyncEngine(), [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      const input = sendMessageSchema.safeParse({ v: 1, conversationId: id, clientMessageId: crypto.randomUUID(), text, ...(reply ? { replyToId: reply.id } : {}) });
      if (!input.success) throw new Error('Write 1-4,000 characters before sending.');
      await engine.queue({ type: 'send', body: input.data }); setText(''); clearReply(); engine.typing(id, false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the pending message.'); }
    finally { setBusy(false); }
  }
  const pending = engine.pending.filter(row => row.conversationId === id);
  return <section className="chat-section composer" aria-label="Write a message"><form onSubmit={event => { void submit(event); }}>
    {reply && <div className="reply-preview"><p>Replying to: {reply.text.slice(0, 120)}</p><button type="button" className="button-secondary" onClick={clearReply}>Cancel reply</button></div>}
    <label className="field">Message<textarea name="message" rows={3} maxLength={8000} value={text} onChange={event => { setText(event.target.value); engine.typing(id, true); }} placeholder="Write something..." /></label>
    {error && <p role="alert" className="notice error">{error}</p>}<p role="status" className="notice">{engine.notice}</p>
    <div className="control-row"><button disabled={busy || !text.trim()}>{busy ? 'Saving...' : 'Send message'}</button><button type="button" className="button-secondary" onClick={() => { setText(''); clearReply(); }}>Discard draft</button></div>
    <p className="hint">{engine.durable ? 'Send saves a pending command before trying the network. Queued commands survive reload and retry with the same ID.' : 'Storage is unavailable. Refreshing can discard unconfirmed commands.'} Unsent text in this box stays in this page.</p>
  </form>{pending.length > 0 && <ul className="pending-list" aria-label="Pending commands">{pending.map(row => <li key={row.key}><p>{row.command.type === 'send' ? row.command.body.text : `Pending ${row.command.body.kind}`}</p><small>{row.state === 'failed' ? row.error : 'Pending acceptance; automatic retry keeps the same command ID.'}</small><button className="button-secondary" disabled={row.leaseUntil > Date.now()} onClick={() => { if (window.confirm('This command may already be accepted. Check history before discarding.')) void engine.discard(row.key); }}>Discard pending command</button></li>)}</ul>}</section>;
}
