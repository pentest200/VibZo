import { FileDownload } from './attachments.js';
import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuthSession, Conversation, SyncMessage } from '@chat/contracts';
import type { EditTarget, ReplyTarget } from './message-composer.js';
import { useSyncEngine } from './sync-context.js';
import { ReportButton } from './safety.js';
import { Icon } from './ui.js';
import { Modal } from './dialog.js';
import { useReadReceipts } from './read-receipts.js';
export function SyncedHistory({ conversation: c, account, onReply, onEdit }: { conversation: Conversation; account: AuthSession; onReply: (reply: ReplyTarget) => void; onEdit: (edit: EditTarget) => void }) {
  const engine = useSyncEngine(), [error, setError] = useState(''), [typing, setTyping] = useState(false), [online, setOnline] = useState<boolean | null>(null), [before, setBefore] = useState<string | null>(null);
  const scroller = useRef<HTMLElement>(null), following = useRef(true);
  const [deleting, setDeleting] = useState<SyncMessage | null>(null), [deleteBusy, setDeleteBusy] = useState(false), [pinsOpen, setPinsOpen] = useState(false);
  const deleteCommand = useRef(crypto.randomUUID());
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
    if (kind === 'edit') { onEdit({ id: message.id, text: message.text, version: message.version }); return; }
    deleteCommand.current = crypto.randomUUID(); setDeleting(message);
  }
  useReadReceipts(engine, c.id, snapshot, scroller, !before && !c.blocked);
  async function deleteMessage(everyone: boolean) {
    if (!deleting || deleteBusy) return; setDeleteBusy(true); setError('');
    try {
      await engine.queue({ type: 'mutation', body: everyone ? { kind: 'delete', commandId: deleteCommand.current, conversationId: c.id, messageId: deleting.id, expectedVersion: deleting.version } : { kind: 'hide', commandId: deleteCommand.current, conversationId: c.id, messageId: deleting.id } }); setDeleting(null);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save deletion.'); } finally { setDeleteBusy(false); }
  }
  const canPin = !c.blocked && (c.kind === 'direct' || c.role !== 'member');
  return <section className="history" ref={scroller} onScroll={() => { const node = scroller.current; if (node) following.current = node.scrollHeight - node.scrollTop - node.clientHeight < 120; }} aria-label="Conversation history"><div className="history-utilities"><ReportButton account={account} conversationId={c.id} messageId={null} /></div>
    {!!snapshot?.pinnedMessages.length && <button type="button" className="pinned-message-bar" onClick={() => setPinsOpen(true)}><Icon name="pin" size={19} /><span><strong>Pinned message{snapshot.pinnedMessages.length > 1 ? `s (${snapshot.pinnedMessages.length})` : ''}</strong><small>{snapshot.pinnedMessages[0]?.text || snapshot.pinnedMessages[0]?.attachments[0]?.name || 'Message'}</small></span></button>}
    {online !== null && !c.blocked && <p className="hint">{online ? 'Recently active · approximate presence' : 'No active device seen recently'}</p>}
    {history.isPending && <p role="status">Recovering conversation…</p>}{history.isError ? <><p role="alert" className="notice error">Conversation unavailable. Reconnect or check membership.</p><button onClick={() => { void history.refetch(); }}>Retry history</button></> : <>
      {error && <p role="alert" className="notice error">{error}</p>}{snapshot?.olderBefore && <button className="button-secondary" onClick={() => setBefore(snapshot.olderBefore)}>Earlier messages</button>}
      {before && <button className="button-secondary" onClick={() => setBefore(null)}>Latest messages</button>}{snapshot && !messages.length && <div className="history-empty"><h3>A fresh conversation.</h3><p>No messages have been sent here yet.</p></div>}
      <ol className="message-list">{messages.map(message => {
        const own = message.senderId === account.user.id, peers = snapshot?.receipts.filter(receipt => receipt.userId !== account.user.id && BigInt(receipt.visibleFrom) <= BigInt(message.creationSequence)) ?? [], read = peers.some(receipt => BigInt(receipt.read) >= BigInt(message.creationSequence)), delivered = peers.some(receipt => BigInt(receipt.deliveredFrom) <= BigInt(message.creationSequence) && BigInt(receipt.delivered) >= BigInt(message.creationSequence));
        return <li key={message.id} data-sequence={message.creationSequence} tabIndex={0} className={own ? 'message own' : 'message incoming'}><small className="message-sender">{own ? 'You' : c.members.find(member => member.user.id === message.senderId)?.user.displayName ?? 'Former member'}{message.replyToId ? ' · Reply' : ''}{message.version !== '0' && !message.deleted ? ' · Edited' : ''}{message.pinned && !message.deleted && <span className="message-pin" title="Pinned message"><Icon name="pin" size={12} /></span>}</small><p className="message-text">{message.deleted ? 'Message deleted' : message.text}</p><ul className="attachment-list">{message.attachments.map(file => <FileDownload key={file.id} file={file} account={account} disabled={c.blocked} />)}</ul><div className="message-meta"><time dateTime={message.createdAt} title={new Date(message.createdAt).toLocaleString()}>{new Date(message.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>{own && !message.deleted && <span className={`message-receipt ${read ? 'is-read' : ''}`} role="img" aria-label={read ? c.kind === 'group' ? 'Read by someone' : 'Read' : delivered ? c.kind === 'group' ? 'Delivered to someone' : 'Delivered' : 'Accepted'} title={read ? 'Read' : delivered ? 'Delivered' : 'Sent'}><Icon name={read || delivered ? 'doubleCheck' : 'check'} size={19} /></span>}</div>
          {!message.deleted && !c.blocked && <details className="message-options"><summary aria-label="Message actions" title="Message actions"><Icon name="more" size={16} /></summary><div className="control-row"><button className="button-secondary" onClick={() => onReply({ id: message.id, text: message.text || message.attachments[0]?.name || 'File' })} aria-label={`Reply to ${(message.text || message.attachments[0]?.name || 'File').slice(0, 40)}`}>Reply</button>{own && <button className="button-secondary" onClick={() => mutate(message, 'edit')}>Edit message</button>}<button className="button-secondary" onClick={() => mutate(message, 'delete')}>Delete message</button>{canPin && <button className="button-secondary" onClick={() => { void action({ type: 'mutation', body: { kind: 'pin', commandId: crypto.randomUUID(), conversationId: c.id, messageId: message.id, active: !message.pinned } }); }}>{message.pinned ? 'Unpin message' : 'Pin message'}</button>}
            <button className="button-secondary" aria-pressed={message.reactions.some(item => item.reaction === 'like' && item.mine)} onClick={() => { void action({ type: 'mutation', body: { kind: 'reaction', commandId: crypto.randomUUID(), conversationId: c.id, messageId: message.id, reaction: 'like', active: !message.reactions.some(item => item.reaction === 'like' && item.mine) } }); }}>Like {message.reactions.find(item => item.reaction === 'like')?.count ?? 0}</button><ReportButton account={account} conversationId={c.id} messageId={message.id} /></div></details>}
        </li>;
      })}</ol>{typing && <p role="status" className="hint">Someone is typing…</p>}
    </>}
    {deleting && <Modal title="Delete message" close={() => { if (!deleteBusy) setDeleting(null); }}><p className="dialog-description">Delete this message from your chat, or remove your message for everyone.</p>{error && <p role="alert" className="notice error">{error}</p>}<div className="delete-message-choices"><button type="button" disabled={deleteBusy} onClick={() => { void deleteMessage(false); }}>Delete for me</button>{deleting.senderId === account.user.id && <button type="button" className="danger-button" disabled={deleteBusy} onClick={() => { void deleteMessage(true); }}>Delete for everyone</button>}<button type="button" className="button-secondary" disabled={deleteBusy} onClick={() => setDeleting(null)}>Cancel</button></div></Modal>}
    {pinsOpen && <Modal title="Pinned messages" close={() => setPinsOpen(false)}><ul className="pinned-message-list">{snapshot?.pinnedMessages.map(message => <li key={message.id}><p>{message.text || 'File'}</p><ul className="attachment-list">{message.attachments.map(file => <FileDownload key={file.id} file={file} account={account} disabled={c.blocked} />)}</ul><small>{new Date(message.createdAt).toLocaleString()}</small>{canPin && <button type="button" className="button-secondary" onClick={() => { void action({ type: 'mutation', body: { kind: 'pin', commandId: crypto.randomUUID(), conversationId: c.id, messageId: message.id, active: false } }); }}>Unpin message</button>}</li>)}</ul>{!snapshot?.pinnedMessages.length && <p>No pinned messages.</p>}</Modal>}
  </section>;
}
