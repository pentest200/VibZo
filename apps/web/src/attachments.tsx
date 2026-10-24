import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { attachmentListSchema, downloadTicketSchema, uploadTicketSchema } from '@chat/contracts';
import type { AttachmentReference, AuthSession } from '@chat/contracts';
import { api } from './api.js';
import { Modal } from './dialog.js';
import { Icon } from './ui.js';
const kinds: Record<string, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'text', 'image/gif': 'gif', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/webm': 'webm', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'application/ogg': 'ogg' };
export function AttachmentPicker({ id, account, selected, change, uploading }: { id: string; account: AuthSession; selected: string[]; change: (ids: string[]) => void; uploading: (busy: boolean) => void }) {
  const [error, setError] = useState(''), [progress, setProgress] = useState<number | null>(null), [busy, setBusy] = useState(false), mounted = useRef(true), cancelled = useRef(false), request = useRef<XMLHttpRequest | null>(null);
  const files = useQuery({ queryKey: ['chat', account.user.id, 'files', id], queryFn: async () => attachmentListSchema.parse(await api(`/attachments?conversationId=${id}`)), refetchInterval: 2000 });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => { const active = new Set(files.data?.items.filter(file => file.state === 'ready').map(file => file.id) ?? []); if (files.data && selected.some(key => !active.has(key))) change(selected.filter(key => active.has(key))); }, [files.data, selected, change]);
  async function choose(file: File | undefined) {
    if (!file || busy) return; cancelled.current = false; setError(''); setBusy(true); uploading(true); setProgress(0);
    try {
      const kind = kinds[file.type]; if (!kind || file.size < 1 || file.size > 26214400) throw new Error('Choose an image, GIF, MP4/WebM video, MP3/WAV/Ogg audio, PDF or plain text file up to 25 MiB.');
      const checksum = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (cancelled.current || !mounted.current) throw new Error('Upload cancelled.');
      const ticket = uploadTicketSchema.parse(await api('/attachments', { method: 'POST', csrf: account.csrfToken, body: { commandId: crypto.randomUUID(), conversationId: id, name: file.name, kind, size: file.size, sha256: checksum } }));
      if (cancelled.current || !mounted.current) throw new Error('Upload cancelled. Remove the incomplete file if it appears below.');
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest(); request.current = xhr; xhr.open('PUT', ticket.url); xhr.timeout = 120000;
        for (const [key, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(key, value);
        xhr.upload.onprogress = event => { if (mounted.current && event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)); };
        xhr.onload = () => xhr.status === 200 ? resolve() : reject(new Error('Upload failed. Remove this file and try again.'));
        xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new Error('Upload interrupted. Remove the incomplete file and try again.')); xhr.send(file);
      });
      await api(`/attachments/${ticket.attachment.id}/finalize`, { method: 'POST', csrf: account.csrfToken, body: { commandId: crypto.randomUUID() } });
      await files.refetch();
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not upload the file.'); }
    finally { request.current = null; if (mounted.current) { setBusy(false); uploading(false); setProgress(null); } }
  }
  async function act(fileId: string, action: 'delete' | 'retry' | 'finalize') {
    setError(''); try { await api(`/attachments/${fileId}/${action}`, { method: 'POST', csrf: account.csrfToken, body: { commandId: crypto.randomUUID() } }); await files.refetch(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Could not update the file.'); }
  }
  return <section className="attachment-picker" aria-label="Attach files"><label className="field">Attach a file<input type="file" accept={Object.keys(kinds).join(',')} disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void choose(file); }} /></label>
    <p className="hint">Images, GIFs, video, audio and documents. Up to 8 files per message, 25 MiB each. Photos are resized to WebP; GIF animation is preserved. Choose files after their safety checks finish.</p>
    {progress !== null && <div role="status">Uploading: {progress}% <progress value={progress} max={100} aria-label="Upload progress" /><button type="button" className="button-secondary" onClick={() => { cancelled.current = true; request.current?.abort(); }}>Cancel upload</button></div>}
    {(error || files.error) && <p role="alert" className="notice error">{error || 'Files unavailable. Reconnect to try again.'}</p>}
    <ul className="attachment-list">{files.data?.items.map(file => <li key={file.id}>
      <label><input type="checkbox" checked={selected.includes(file.id)} disabled={file.state !== 'ready' || !selected.includes(file.id) && selected.length >= 8} onChange={event => change(event.target.checked ? [...selected, file.id] : selected.filter(key => key !== file.id))} />{file.name}</label>
      <small>{file.state === 'ready' ? 'Ready to send' : file.state === 'pending' ? 'Upload incomplete' : file.state === 'uploaded' || file.state === 'processing' ? file.error || 'Checking file safety…' : file.state === 'rejected' ? 'File rejected' : 'Removing file…'}</small>
      {file.error && <span className="hint">{file.error}</span>}
      {file.state === 'pending' && <button type="button" className="button-secondary" onClick={() => { void act(file.id, 'finalize'); }}>Check uploaded file</button>}
      {file.state === 'uploaded' && file.error && <button type="button" className="button-secondary" onClick={() => { void act(file.id, 'retry'); }}>Retry checks</button>}
      {file.state !== 'deleting' && <button type="button" className="button-secondary" onClick={() => { change(selected.filter(key => key !== file.id)); void act(file.id, 'delete'); }}>Remove {file.name}</button>}
    </li>)}</ul><p className="hint">Unused files expire after 24 hours. An interrupted upload may need to be selected again.</p>
  </section>;
}
export function FileDownload({ file, account, disabled }: { file: AttachmentReference; account: AuthSession; disabled: boolean }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [viewing, setViewing] = useState(false), [ticket, setTicket] = useState<{ url: string; expiresAt: string } | null>(null), [visible, setVisible] = useState(false);
  const card = useRef<HTMLLIElement>(null), inlineMedia = useRef<HTMLMediaElement | null>(null);
  const visual = ['jpeg', 'png', 'webp', 'gif'].includes(file.kind), audio = ['mp3', 'wav', 'ogg'].includes(file.kind), video = ['mp4', 'webm'].includes(file.kind), playable = visual || audio || video;
  const source = disabled ? '' : ticket?.url ?? '';
  useEffect(() => {
    if (!playable || disabled || !card.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '160px' });
    observer.observe(card.current); return () => observer.disconnect();
  }, [playable, disabled]);
  useEffect(() => {
    if (!visible || !playable || disabled) return;
    let active = true; setBusy(true); setError('');
    void mediaGrant(account, file.id).then(result => { if (active) setTicket(result); }).catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'Media unavailable.'); }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [visible, playable, disabled, account.user.id, account.sessionId, account.csrfToken, file.id]);
  useEffect(() => { if (disabled) { setViewing(false); setTicket(null); inlineMedia.current?.pause(); } }, [disabled]);
  async function preview() {
    inlineMedia.current?.pause(); setViewing(true); setError('');
    if (ticket && Date.parse(ticket.expiresAt) > Date.now() + 5000) return;
    setBusy(true);
    try { setTicket(await mediaGrant(account, file.id)); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'File unavailable.'); } finally { setBusy(false); }
  }
  async function reload() { setTicket(null); setBusy(true); setError(''); try { setTicket(await mediaGrant(account, file.id)); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Media unavailable.'); } finally { setBusy(false); } }
  async function download() {
    setError(''); setBusy(true);
    try { const ticket = downloadTicketSchema.parse(await api(`/attachments/${file.id}/download`, { method: 'POST', body: {}, csrf: account.csrfToken })); const link = document.createElement('a'); link.href = ticket.url; link.rel = 'noreferrer'; link.download = file.name; document.body.append(link); link.click(); link.remove(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'File unavailable.'); } finally { setBusy(false); }
  }
  return <li ref={card} className={`file-card ${playable ? 'inline-media-card' : 'document-card'}`} data-media-kind={file.kind}>
    {playable ? <><div className={`inline-media ${audio ? 'inline-audio' : ''}`}>
      {!source && <div className="media-placeholder" role="status">{busy ? 'Loading media…' : disabled ? 'Media unavailable' : 'Media'}{!busy && error && <button type="button" className="button-secondary" onClick={() => { void reload(); }}>Retry media</button>}</div>}
      {source && (visual ? <button type="button" className="inline-image" aria-label={`View ${file.name}`} onClick={() => { void preview(); }}><img src={source} alt={file.name} referrerPolicy="no-referrer" onError={() => setError('Image unavailable. Reload to request fresh access.')} /></button> : audio ? <><span className="audio-name">{file.name}</span><audio ref={node => { inlineMedia.current = node; }} src={source} controls preload="metadata" aria-label={file.name} onError={() => setError('Audio unavailable or unsupported. Reload or download the file.')} /></> : <video ref={node => { inlineMedia.current = node; }} src={source} controls playsInline preload="metadata" aria-label={file.name} onError={() => setError('Video unavailable or unsupported. Reload or download the file.')} />)}
    </div><div className="inline-media-tools">{!visual && <button type="button" className="icon-button" disabled={disabled || busy} aria-label={`${audio ? 'Listen to' : 'View'} ${file.name}`} title="Open media" onClick={() => { void preview(); }}><Icon name="expand" size={16} /></button>}<small>{Math.ceil(file.size / 1024)} KiB{file.kind === 'gif' ? ' · GIF' : ''}</small><button type="button" className="icon-button" disabled={disabled || busy} aria-label={`Download ${file.name}`} title="Download file" onClick={() => { void download(); }}><Icon name="download" size={17} /></button></div></> : <><button type="button" className="button-secondary file-download-button" disabled={disabled || busy} onClick={() => { void download(); }}><Icon name="attach" size={20} />Download {file.name}</button><small>{Math.ceil(file.size / 1024)} KiB</small></>}
    {error && !viewing && <div className="media-error"><p role="alert">{error}</p><button type="button" className="button-secondary" disabled={busy || disabled} onClick={() => { void reload(); }}>Reload media</button></div>}
    {viewing && !disabled && <Modal title={file.name} className="media-viewer" close={() => { setViewing(false); setError(''); }}>
      <div className="media-stage">{busy && <p role="status">Opening private media…</p>}{source && (visual ? <img src={source} alt={file.name} referrerPolicy="no-referrer" onError={() => setError('The image could not be opened. Reload the preview or download the file.')} /> : audio ? <audio key={source} src={source} controls preload="metadata" aria-label={file.name} onError={() => setError('This audio could not be played. Reload the preview or download the file.')} /> : <video key={source} src={source} controls playsInline preload="metadata" aria-label={file.name} onError={() => setError('This video could not be played. Reload the preview or download the file.')} />)}</div>
      {error && <p className="notice error" role="alert">{error}</p>}<div className="dialog-actions"><button className="button-secondary" disabled={busy} onClick={() => { void reload(); }}>Reload preview</button><button disabled={busy} onClick={() => { void download(); }}>Download {file.name}</button></div>
    </Modal>}
  </li>;
}

// Lazy grants have bounded concurrency and exist only in memory while requested.
const mediaRequests = new Map<string, Promise<{ url: string; expiresAt: string }>>();
const mediaWaiters: (() => void)[] = []; let mediaRunning = 0;
function mediaGrant(account: AuthSession, id: string) {
  const key = `${account.user.id}:${account.sessionId}:${id}`, old = mediaRequests.get(key); if (old) return old;
  const request = (async () => {
    if (mediaRunning >= 3) await new Promise<void>(resolve => mediaWaiters.push(resolve)); else mediaRunning++;
    try { return downloadTicketSchema.parse(await api(`/attachments/${id}/preview`, { method: 'POST', body: {}, csrf: account.csrfToken })); }
    finally { const next = mediaWaiters.shift(); if (next) next(); else mediaRunning--; }
  })().finally(() => { mediaRequests.delete(key); });
  mediaRequests.set(key, request); return request;
}
