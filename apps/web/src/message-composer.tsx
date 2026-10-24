import { AttachmentPicker } from './attachments.js';
import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { sendMessageSchema } from '@chat/contracts';
import type { AuthSession } from '@chat/contracts';
import { useSyncEngine } from './sync-context.js';
import { Icon } from './ui.js';
export interface ReplyTarget { id: string; text: string }
export function MessageComposer({ id, account, reply, clearReply }: { id: string; account: AuthSession; reply: ReplyTarget | null; clearReply: () => void }) {
  const engine = useSyncEngine(), [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [selected, setSelected] = useState<string[]>([]), [uploading, setUploading] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false), [emojiOpen, setEmojiOpen] = useState(false), input = useRef<HTMLTextAreaElement>(null);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      const input = sendMessageSchema.safeParse({ v: 1, conversationId: id, clientMessageId: crypto.randomUUID(), text, attachmentIds: selected, ...(reply ? { replyToId: reply.id } : {}) });
      if (!input.success) throw new Error('Write up to 4,000 characters or choose a ready file.');
      await engine.queue({ type: 'send', body: input.data }); setText(''); setSelected([]); setAttachmentsOpen(false); clearReply(); engine.typing(id, false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the pending message.'); }
    finally { setBusy(false); input.current?.focus(); }
  }
  const pending = engine.pending.filter(row => row.conversationId === id && (row.command.type === 'send' || row.state === 'failed'));
  return <section className="composer" aria-label="Write a message"><form onKeyDown={event => { if (event.key === 'Escape') { setAttachmentsOpen(false); setEmojiOpen(false); input.current?.focus(); } }} onSubmit={event => { void submit(event); }}>
    {reply && <div className="reply-preview"><span><strong>Reply</strong><p>{reply.text.slice(0, 120)}</p></span><button type="button" className="icon-button" aria-label="Cancel reply" onClick={clearReply}><Icon name="close" size={20} /></button></div>}
    <div className="composer-input-row"><button type="button" className="icon-button emoji-trigger" aria-label="Choose emoji" aria-expanded={emojiOpen} onClick={() => { setEmojiOpen(!emojiOpen); setAttachmentsOpen(false); }}><Icon name="smile" /></button>
    {emojiOpen && <div className="emoji-picker" role="group" aria-label="Emoji"><span>Say it with an emoji</span>{['😊','❤️','👍','🎉','😂','👋','🔥','✨','🙌','🤔','💜','🎂','👏','🌻','☕','✅'].map(emoji => <button type="button" key={emoji} aria-label={`Insert ${emoji}`} onClick={() => { const start = input.current?.selectionStart ?? text.length, end = input.current?.selectionEnd ?? start; setText(text.slice(0, start) + emoji + text.slice(end)); setEmojiOpen(false); input.current?.focus(); }}>{emoji}</button>)}</div>}
    <label className="composer-message"><span className="sr-only">Message</span><textarea ref={input} aria-label="Message" name="message" rows={1} maxLength={8000} value={text} onChange={event => { setText(event.target.value); engine.typing(id, true); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !busy && !uploading && (text.trim() || selected.length)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Message" /></label>
    <button type="button" className="icon-button attachment-trigger" aria-label="Attach files" aria-expanded={attachmentsOpen} onClick={() => { setAttachmentsOpen(!attachmentsOpen); setEmojiOpen(false); }}><Icon name="attach" />{selected.length > 0 && <span className="attachment-count">{selected.length}</span>}</button>
    <button type="button" className="icon-button discard-draft" aria-label="Discard draft" title="Discard draft" disabled={!text && !reply} onClick={() => { setText(''); clearReply(); }}><Icon name="close" size={18} /></button>
    <button className="send-button" aria-label={busy ? 'Saving...' : 'Send message'} title="Send message · Enter" disabled={busy || uploading || !text.trim() && !selected.length}><Icon name="send" size={24} /></button></div>
    <div className="attachment-popover" hidden={!attachmentsOpen}><div className="section-heading"><h3>Send a file</h3><button type="button" className="icon-button" aria-label="Close attachments" onClick={() => setAttachmentsOpen(false)}><Icon name="close" size={20} /></button></div><AttachmentPicker id={id} account={account} selected={selected} change={setSelected} uploading={setUploading} /></div>
    {error && <p role="alert" className="notice error">{error}</p>}{engine.notice && <p role="status" className={engine.notice === 'Accepted by the server.' ? 'sr-only' : 'notice'}>{engine.notice}</p>}{!engine.durable && <p className="notice error">Storage is unavailable. Refreshing can discard unconfirmed commands.</p>}
    <span className="composer-caption">Enter to send · Shift + Enter for a new line{Array.from(text).length > 3700 ? ` · ${Array.from(text).length}/4,000` : ''}</span>
  </form>{pending.length > 0 && <ul className="pending-list" aria-label="Pending commands">{pending.map(row => <li key={row.key}><p>{row.command.type === 'send' ? row.command.body.text : `Pending ${row.command.body.kind}`}</p><small>{row.state === 'failed' ? row.error : 'Pending acceptance; automatic retry keeps the same command ID.'}</small><button className="button-secondary" disabled={row.leaseUntil > Date.now()} onClick={() => { if (window.confirm('This command may already be accepted. Check history before discarding.')) void engine.discard(row.key); }}>Discard pending command</button></li>)}</ul>}</section>;
}
