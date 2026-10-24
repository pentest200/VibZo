import { AttachmentPicker } from './attachments.js';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { sendMessageSchema } from '@chat/contracts';
import type { AuthSession } from '@chat/contracts';
import { useSyncEngine } from './sync-context.js';
import { Icon } from './ui.js';
import { EmojiPicker } from './emoji-picker.js';
export interface ReplyTarget { id: string; text: string }
export interface EditTarget { id: string; text: string; version: string }
export function MessageComposer({ id, account, reply, clearReply, edit, clearEdit }: { id: string; account: AuthSession; reply: ReplyTarget | null; clearReply: () => void; edit: EditTarget | null; clearEdit: () => void }) {
  const engine = useSyncEngine(), [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [selected, setSelected] = useState<string[]>([]), [uploading, setUploading] = useState(false);
  const [attachmentsOpen, setAttachmentsOpen] = useState(false), [emojiOpen, setEmojiOpen] = useState(false), input = useRef<HTMLTextAreaElement>(null);
  const savedDraft = useRef(''), previousEdit = useRef<string | null>(null);
  useEffect(() => {
    if (edit && previousEdit.current !== edit.id) { if (!previousEdit.current) savedDraft.current = input.current?.value ?? ''; setText(edit.text); setAttachmentsOpen(false); setEmojiOpen(false); setError(''); input.current?.focus(); }
    else if (!edit && previousEdit.current) { setText(savedDraft.current); savedDraft.current = ''; input.current?.focus(); }
    previousEdit.current = edit?.id ?? null;
  }, [edit]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (busy) return; setBusy(true); setError('');
    try {
      if (edit) {
        if (!text.trim() || Array.from(text).length > 4000) throw new Error('Write between 1 and 4,000 characters.');
        await engine.queue({ type: 'mutation', body: { kind: 'edit', commandId: crypto.randomUUID(), conversationId: id, messageId: edit.id, expectedVersion: edit.version, text } });
        clearEdit(); return;
      }
      const input = sendMessageSchema.safeParse({ v: 1, conversationId: id, clientMessageId: crypto.randomUUID(), text, attachmentIds: selected, ...(reply ? { replyToId: reply.id } : {}) });
      if (!input.success) throw new Error('Write up to 4,000 characters or choose a ready file.');
      await engine.queue({ type: 'send', body: input.data }); setText(''); setSelected([]); setAttachmentsOpen(false); clearReply(); engine.typing(id, false);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not save the pending message.'); }
    finally { setBusy(false); input.current?.focus(); }
  }
  const pending = engine.pending.filter(row => row.conversationId === id && (row.command.type === 'send' || row.state === 'failed'));
  return <section className="composer" aria-label="Write a message"><form onKeyDown={event => { if (event.key === 'Escape') { setAttachmentsOpen(false); setEmojiOpen(false); if (edit) clearEdit(); else if (reply) clearReply(); input.current?.focus(); } }} onSubmit={event => { void submit(event); }}>
    {edit && <div className="reply-preview edit-preview" role="status"><Icon name="edit" size={20} /><span><strong>Editing message</strong><p>{edit.text || 'Message caption'}</p></span><button type="button" className="icon-button" aria-label="Cancel edit" onClick={clearEdit}><Icon name="close" size={20} /></button></div>}
    {reply && <div className="reply-preview"><span><strong>Reply</strong><p>{reply.text.slice(0, 120)}</p></span><button type="button" className="icon-button" aria-label="Cancel reply" onClick={clearReply}><Icon name="close" size={20} /></button></div>}
    <div className="composer-input-row"><button type="button" className="icon-button emoji-trigger" aria-label="Choose emoji" aria-expanded={emojiOpen} onClick={() => { setEmojiOpen(!emojiOpen); setAttachmentsOpen(false); }}><Icon name="smile" /></button>
    {emojiOpen && <EmojiPicker close={() => { setEmojiOpen(false); input.current?.focus(); }} insert={emoji => { const start = input.current?.selectionStart ?? text.length, end = input.current?.selectionEnd ?? start; setText(text.slice(0, start) + emoji + text.slice(end)); setEmojiOpen(false); requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(start + emoji.length, start + emoji.length); }); }} />}
    <label className="composer-message"><span className="sr-only">Message</span><textarea ref={input} aria-label="Message" name="message" rows={1} maxLength={8000} value={text} onChange={event => { setText(event.target.value); engine.typing(id, true); }} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && !busy && !uploading && (text.trim() || selected.length)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} placeholder="Message" /></label>
    <button type="button" className="icon-button attachment-trigger" aria-label="Attach files" disabled={!!edit} aria-expanded={attachmentsOpen} onClick={() => { setAttachmentsOpen(!attachmentsOpen); setEmojiOpen(false); }}><Icon name="attach" />{selected.length > 0 && <span className="attachment-count">{selected.length}</span>}</button>
    <button type="button" className="icon-button discard-draft" aria-label="Discard draft" title="Discard draft" disabled={!text && !reply} onClick={() => { setText(''); clearReply(); }}><Icon name="close" size={18} /></button>
    <button className="send-button" aria-label={busy ? 'Saving...' : edit ? 'Save changes' : 'Send message'} title={edit ? 'Save changes · Enter' : 'Send message · Enter'} disabled={busy || uploading || !text.trim() && (!!edit || !selected.length)}><Icon name={edit ? 'check' : 'send'} size={24} /></button></div>
    <div className="attachment-popover" hidden={!attachmentsOpen}><div className="section-heading"><h3>Send a file</h3><button type="button" className="icon-button" aria-label="Close attachments" onClick={() => setAttachmentsOpen(false)}><Icon name="close" size={20} /></button></div><AttachmentPicker id={id} account={account} selected={selected} change={setSelected} uploading={setUploading} /></div>
    {error && <p role="alert" className="notice error">{error}</p>}{engine.notice && <p role="status" className={engine.notice === 'Accepted by the server.' ? 'sr-only' : 'notice'}>{engine.notice}</p>}{!engine.durable && <p className="notice error">Storage is unavailable. Refreshing can discard unconfirmed commands.</p>}
    <span className="composer-caption">Enter to send · Shift + Enter for a new line{Array.from(text).length > 3700 ? ` · ${Array.from(text).length}/4,000` : ''}</span>
  </form>{pending.length > 0 && <ul className="pending-list" aria-label="Pending commands">{pending.map(row => <li key={row.key}><p>{row.command.type === 'send' ? row.command.body.text : `Pending ${row.command.body.kind}`}</p><small>{row.state === 'failed' ? row.error : 'Pending acceptance; automatic retry keeps the same command ID.'}</small><button className="button-secondary" disabled={row.leaseUntil > Date.now()} onClick={() => { if (window.confirm('This command may already be accepted. Check history before discarding.')) void engine.discard(row.key); }}>Discard pending command</button></li>)}</ul>}</section>;
}
