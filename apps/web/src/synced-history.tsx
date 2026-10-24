import { FileDownload } from './attachments.js';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuthSession, Conversation, SyncMessage } from '@chat/contracts';
import type { ReplyTarget } from './message-composer.js';
import { useSyncEngine } from './sync-context.js';
import { ReportButton } from './safety.js';
export function SyncedHistory({ conversation: c, account, onReply }: { conversation: Conversation; account: AuthSession; onReply: (reply: ReplyTarget) => void }) {
  const engine = useSyncEngine(), [error, setError] = useState(''), [typing, setTyping] = useState(false), [online, setOnline] = useState<boolean | null>(null), [before, setBefore] = useState<string | null>(null);
  const scroller = useRef<HTMLElement>(null), following = useRef(true);
  const history = useQuery({ queryKey: ['chat', account.user.id, 'sync', c.id, ...(before ? [before] : [])], queryFn: () => before ? engine.olderWindow(c.id, before) : engine.synchronize(c.id), retry: false, gcTime: 0 });
  useEffect(() => {
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const listener = (event: Event) => { const packet = (event as CustomEvent<{ conversationId: string; active: boolean }>).detail; if (packet.conversationId !== c.id) return; setTyping(packet.active); if (expiry) clearTimeout(expiry); expiry = setTimeout(() => setTyping(false), 4000); };
    window.addEventListener('commonroom-typing', listener); return () => { window.removeEventListener('commonroom-typing', listener); if (expiry) clearTimeout(expiry); };
  }, [c.id]);
  useEffect(() => { let active = true; const poll = () => { if (c.otherUserId) void engine.presence(c.id, c.otherUserId).then(result => { if (active) setOnline(result); }); }; poll(); const timer = setInterval(poll, 10000); return () => { active = false; clearInterval(timer); }; }, [engine, c.id, c.otherUserId]);
  useEffect(() => { setBefore(null); }, [c.id]);
  const snapshot = history.data, messages = [...snapshot?.messages ?? []].reverse();
  const newest = messages.at(-1)?.id;
  useEffect(() => { if (!before && following.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight; }, [newest, before]);
  async function action(body: Parameters<typeof engine.queue>[0]) { setError(''); try { await engine.queue(body); } catch (error) { setError(error instanceof Error ? error.message : 'Could not save the action.'); } }
  function mutate(message: SyncMessage, kind: 'edit' | 'delete') {
    if (kind === 'delete' && !window.confirm('Delete this message for everyone?')) return;
    const text = kind === 'edit' ? window.prompt('Edit message', message.text) : null; if (kind === 'edit' && text === null) return;
    const common = { commandId: crypto.randomUUID(), conversationId: c.id, messageId: message.id, expectedVersion: message.version };
    void action({ type: 'mutation', body: kind === 'edit' ? { ...common, kind, text: text! } : { ...common, kind } });
  }
  const min = messages[0]?.creationSequence ?? '0';
  const max = messages.reduce((last, message) => BigInt(message.creationSequence) > BigInt(last) ? message.creationSequence : last, '0');
  useEffect(() => {
    if (!snapshot || before || c.blocked || !engine.durable) return;
    const own = snapshot.receipts.find(receipt => receipt.userId === account.user.id);
    const already = engine.pending.some(row => row.command.type === 'mutation' && row.command.body.kind === 'receipt' && row.conversationId === c.id && BigInt(row.command.body.delivered) >= BigInt(max));
    if (BigInt(max) > BigInt(own?.delivered ?? '0') && !already) void action({ type: 'mutation', body: { kind: 'receipt', appliedFrom: min, commandId: crypto.randomUUID(), conversationId: c.id, delivered: max, read: own?.read ?? '0' } });
  }, [snapshot, before, min, max, c.blocked, c.id, account.user.id, engine]);
  return <section className="history" ref={scroller} onScroll={() => { const node = scroller.current; if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; }} aria-label="Conversation history"><div className="history-utilities"><ReportButton account={account} conversationId={c.id} messageId={null} /></div>
    {online !== null && !c.blocked && <p className="hint">{online ? 'Recently active · approximate presence' : 'No active device seen recently'}</p>}
    {history.isPending && <p role="status">Recovering conversation…</p>}{history.isError ? <><p role="alert" className="notice error">Conversation unavailable. Reconnect or check membership.</p><button onClick={() => { void history.refetch(); }}>Retry history</button></> : <>
      {error && <p role="alert" className="notice error">{error}</p>}{snapshot?.olderBefore && <button className="button-secondary" onClick={() => setBefore(snapshot.olderBefore)}>Earlier messages</button>}
      {before && <button className="button-secondary" onClick={() => setBefore(null)}>Latest messages</button>}{snapshot && !messages.length && <div className="history-empty"><h3>A fresh conversation.</h3><p>No messages have been sent here yet.</p></div>}
      <ol className="message-list">{messages.map(message => {
        const own = message.senderId === account.user.id, peers = snapshot?.receipts.filter(receipt => receipt.userId !== account.user.id && BigInt(receipt.visibleFrom) <= BigInt(message.creationSequence)) ?? [], read = peers.some(receipt => BigInt(receipt.read) >= BigInt(message.creationSequence)), delivered = peers.some(receipt => BigInt(receipt.deliveredFrom) <= BigInt(message.creationSequence) && BigInt(receipt.delivered) >= BigInt(message.creationSequence));
        return <li key={message.id} tabIndex={0} className={own ? 'message own' : 'message incoming'}><small className="message-sender">{own ? 'You' : c.members.find(member => member.user.id === message.senderId)?.user.displayName ?? 'Former member'}{message.replyToId ? ' · Reply' : ''}{message.version !== '0' && !message.deleted ? ' · Edited' : ''}</small><p className="message-text">{message.deleted ? 'Message deleted' : message.text}</p><ul className="attachment-list">{message.attachments.map(file => <FileDownload key={file.id} file={file} account={account} disabled={c.blocked} />)}</ul><div className="message-meta"><time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{own && !message.deleted && <small className="message-receipt">{read ? c.kind === 'group' ? 'Read by someone' : 'Read' : delivered ? c.kind === 'group' ? 'Delivered to someone' : 'Delivered' : 'Accepted'}</small>}</div>
          {!message.deleted && !c.blocked && <div className="control-row"><button className="button-secondary" onClick={() => onReply({ id: message.id, text: message.text || message.attachments[0]?.name || 'File' })} aria-label={`Reply to ${(message.text || message.attachments[0]?.name || 'File').slice(0, 40)}`}>Reply</button>{own && <><button className="button-secondary" onClick={() => mutate(message, 'edit')}>Edit message</button><button className="button-secondary" onClick={() => mutate(message, 'delete')}>Delete message</button></>}
            <button className="button-secondary" aria-pressed={message.reactions.some(item => item.reaction === 'like' && item.mine)} onClick={() => { void action({ type: 'mutation', body: { kind: 'reaction', commandId: crypto.randomUUID(), conversationId: c.id, messageId: message.id, reaction: 'like', active: !message.reactions.some(item => item.reaction === 'like' && item.mine) } }); }}>Like {message.reactions.find(item => item.reaction === 'like')?.count ?? 0}</button><ReportButton account={account} conversationId={c.id} messageId={message.id} /></div>}
        </li>;
      })}</ol>{typing && <p role="status" className="hint">Someone is typing…</p>}
      {!c.blocked && max !== '0' && <button className="button-secondary" onClick={() => { void action({ type: 'mutation', body: { kind: 'receipt', appliedFrom: min, commandId: crypto.randomUUID(), conversationId: c.id, delivered: max, read: max } }); }}>Mark messages read</button>}
    </>}
  </section>;
}
