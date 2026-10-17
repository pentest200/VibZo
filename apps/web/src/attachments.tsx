import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { attachmentListSchema, downloadTicketSchema, uploadTicketSchema } from '@chat/contracts';
import type { AttachmentReference, AuthSession } from '@chat/contracts';
import { api } from './api.js';
const kinds: Record<string, string> = { 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'text' };
export function AttachmentPicker({ id, account, selected, change, uploading }: { id: string; account: AuthSession; selected: string[]; change: (ids: string[]) => void; uploading: (busy: boolean) => void }) {
  const [error, setError] = useState(''), [progress, setProgress] = useState<number | null>(null), [busy, setBusy] = useState(false), mounted = useRef(true), cancelled = useRef(false), request = useRef<XMLHttpRequest | null>(null);
  const files = useQuery({ queryKey: ['chat', account.user.id, 'files', id], queryFn: async () => attachmentListSchema.parse(await api(`/attachments?conversationId=${id}`)), refetchInterval: 2000 });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  useEffect(() => { const active = new Set(files.data?.items.filter(file => file.state === 'ready').map(file => file.id) ?? []); if (files.data && selected.some(key => !active.has(key))) change(selected.filter(key => active.has(key))); }, [files.data, selected, change]);
  async function choose(file: File | undefined) {
    if (!file || busy) return; cancelled.current = false; setError(''); setBusy(true); uploading(true); setProgress(0);
    try {
      const kind = kinds[file.type]; if (!kind || file.size < 1 || file.size > 26214400) throw new Error('Choose a JPEG, PNG, WebP, PDF or plain text file up to 25 MiB.');
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
  return <section className="attachment-picker" aria-label="Attach files"><label className="field">Attach a file<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf,text/plain" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void choose(file); }} /></label>
    <p className="hint">Up to 8 files per message, 25 MiB each. Images are resized and saved as WebP. Choose files after their safety checks finish.</p>
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
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function download() {
    setError(''); setBusy(true);
    try { const ticket = downloadTicketSchema.parse(await api(`/attachments/${file.id}/download`, { method: 'POST', body: {}, csrf: account.csrfToken })); const link = document.createElement('a'); link.href = ticket.url; link.rel = 'noreferrer'; link.download = file.name; document.body.append(link); link.click(); link.remove(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'File unavailable.'); } finally { setBusy(false); }
  }
  return <li><button type="button" className="button-secondary" disabled={disabled || busy} onClick={() => { void download(); }}>Download {file.name}</button> <small>{Math.ceil(file.size / 1024)} KiB</small>{error && <p role="alert">{error}</p>}</li>;
}
