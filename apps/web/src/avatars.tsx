import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { avatarAckSchema, avatarSettingsSchema, downloadTicketSchema, uploadTicketSchema } from '@chat/contracts';
import type { AuthSession } from '@chat/contracts';
import { api } from './api.js';
import { accountKey, queryClient } from './auth-state.js';

export function AvatarImage({ account, userId, name, conversationId, avatarId }: { account: AuthSession; userId: string; name: string; conversationId?: string; avatarId?: string | null }) {
  const element = useRef<HTMLSpanElement | null>(null), [visible, setVisible] = useState(false), [failedUrl, setFailedUrl] = useState(''), [expiredUrl, setExpiredUrl] = useState('');
  useEffect(() => {
    if (!element.current || !('IntersectionObserver' in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(entries => setVisible(entries.some(entry => entry.isIntersecting)));
    observer.observe(element.current); return () => observer.disconnect();
  }, []);
  const image = useQuery({ queryKey: ['chat', account.user.id, 'avatar', userId, conversationId ?? 'self', avatarId],
    queryFn: async () => downloadTicketSchema.parse(await api(`/avatars/${userId}/download`, { method: 'POST', csrf: account.csrfToken, body: conversationId ? { conversationId } : {} })),
    enabled: visible && avatarId !== null, refetchInterval: visible ? 15000 : false, gcTime: 0 });
  const url = image.data?.url ?? '';
  useEffect(() => {
    if (!image.data) return;
    const timer = window.setTimeout(() => setExpiredUrl(url), Math.max(0, Date.parse(image.data.expiresAt) - Date.now()));
    return () => window.clearTimeout(timer);
  }, [image.data, url]);
  const show = !image.isError && image.isFetchedAfterMount && url && url !== failedUrl && url !== expiredUrl && Date.parse(image.data!.expiresAt) > Date.now();
  return <span className="avatar" ref={element}>{show ? <img src={url} alt={`${name}'s avatar`} referrerPolicy="no-referrer" onError={() => setFailedUrl(url)} /> : <span aria-hidden="true">{name.slice(0, 1).toUpperCase()}</span>}</span>;
}

export function AvatarSettings({ account }: { account: AuthSession }) {
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [progress, setProgress] = useState<number | null>(null);
  const [requestedVisibility, setRequestedVisibility] = useState<boolean | null>(null);
  const mounted = useRef(true), cancelled = useRef(false), request = useRef<XMLHttpRequest | null>(null), commands = useRef(new Map<string, string>());
  const profile = useQuery({ queryKey: ['chat', account.user.id, 'avatar-settings'], queryFn: async () => avatarSettingsSchema.parse(await api('/avatars')), enabled: account.user.verified, refetchInterval: 2000 });
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);
  const commandId = (key: string) => { let id = commands.current.get(key); if (!id) { id = crypto.randomUUID(); commands.current.set(key, id); } return id; };
  async function refresh() {
    if (!mounted.current) return;
    await profile.refetch(); if (!mounted.current) return;
    await queryClient.invalidateQueries({ queryKey: accountKey }); if (!mounted.current) return;
    await queryClient.invalidateQueries({ queryKey: ['chat', account.user.id, 'avatar'] });
  }
  async function act(path: string, body: Record<string, unknown>) {
    if (busy) return; const key = JSON.stringify({ path, ...body }); setBusy(true); setError(''); setNotice('');
    try { avatarAckSchema.parse(await api(`/avatars/${path}`, { method: 'POST', csrf: account.csrfToken, body: { ...body, commandId: commandId(key) } })); commands.current.delete(key); await refresh(); if (mounted.current) setNotice('Avatar settings saved.'); }
    catch (failure) { if (mounted.current) { setError(failure instanceof Error ? failure.message : 'Could not update your avatar.'); void profile.refetch(); } }
    finally { if (mounted.current) setBusy(false); }
  }
  async function check(id: string, action: 'retry' | 'finalize') {
    if (busy) return; const key = `${id}/${action}`; setBusy(true); setError('');
    try { await api(`/avatars/${key}`, { method: 'POST', csrf: account.csrfToken, body: { commandId: commandId(key) } }); commands.current.delete(key); if (mounted.current) await profile.refetch(); }
    catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not check the image.'); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function choose(file: File | undefined) {
    if (!file || busy) return; setError(''); setNotice(''); setBusy(true); setProgress(0); cancelled.current = false;
    try {
      const kind = ({ 'image/jpeg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[file.type];
      if (!kind || file.size < 1 || file.size > 5242880) throw new Error('Choose a JPEG, PNG or WebP image up to 5 MiB.');
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.arrayBuffer()))).map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (cancelled.current || !mounted.current) throw new Error('Upload cancelled.');
      const ticket = uploadTicketSchema.parse(await api('/avatars', { method: 'POST', csrf: account.csrfToken, body: { commandId: crypto.randomUUID(), name: file.name, kind, size: file.size, sha256 } }));
      if (cancelled.current || !mounted.current) throw new Error('Upload cancelled. Remove the incomplete image if it appears below.');
      await new Promise<void>((resolve, reject) => {
        const xhr = new XMLHttpRequest(); request.current = xhr; xhr.open('PUT', ticket.url); xhr.timeout = 120000;
        for (const [key, value] of Object.entries(ticket.headers)) xhr.setRequestHeader(key, value);
        xhr.upload.onprogress = event => { if (mounted.current && event.lengthComputable) setProgress(Math.round(event.loaded / event.total * 100)); };
        xhr.onload = () => xhr.status === 200 ? resolve() : reject(new Error('Upload failed. Remove this image and try again.'));
        xhr.onerror = xhr.ontimeout = xhr.onabort = () => reject(new Error('Upload interrupted. Refresh the image list before trying again.')); xhr.send(file);
      });
      await api(`/avatars/${ticket.attachment.id}/finalize`, { method: 'POST', csrf: account.csrfToken, body: { commandId: commandId(`${ticket.attachment.id}/finalize`) } });
      if (mounted.current) { await profile.refetch(); if (mounted.current) setNotice('Image uploaded. Wait for safety checks, then choose Use as avatar.'); }
    } catch (failure) { if (mounted.current) setError(failure instanceof Error ? failure.message : 'Could not upload the image.'); }
    finally { request.current = null; if (mounted.current) { setBusy(false); setProgress(null); void profile.refetch(); } }
  }
  return <section className="panel avatar-settings" aria-label="Avatar settings"><h2>Your avatar</h2>
    {!account.user.verified ? <p>Verify your email to upload an avatar.</p> : <>
      {profile.isPending ? <p role="status">Loading avatar settings…</p> : profile.isError ? <><p role="alert">Avatar settings unavailable. Reconnect and retry.</p><button className="button-secondary" onClick={() => { void profile.refetch(); }}>Retry avatar settings</button></> : <>
        <AvatarImage account={account} userId={account.user.id} name={account.user.displayName} avatarId={profile.data.avatarId} />
        <label className="check"><input type="checkbox" checked={requestedVisibility ?? profile.data.visibility === 'conversations'} disabled={busy} onChange={event => { const share = event.target.checked; setRequestedVisibility(share); void act('privacy', { visibility: share ? 'conversations' : 'self' }).finally(() => { if (mounted.current) setRequestedVisibility(null); }); }} /> Share my avatar with active conversation members</label>
        <p className="hint">Only you can view it until you choose to share. Blocked people cannot request it. Previously issued image links can work for up to 30 seconds; images already seen cannot be recalled.</p>
        <label className="field">Upload avatar<input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; void choose(file); }} /></label>
        <p className="hint">JPEG, PNG or WebP, up to 5 MiB. Images pass safety checks and are saved as WebP, up to 2048 pixels. Uploading keeps your current avatar until you choose a replacement. Up to ten current, unused or retiring images; unused uploads expire after 24 hours.</p>
        <ul className="avatar-candidates">{profile.data.items.map(file => <li key={file.id}><span>{file.name} · {profile.data.avatarId === file.id ? 'Current avatar' : file.state === 'ready' ? 'Ready to use' : file.state === 'uploaded' || file.state === 'processing' ? file.error || 'Checking image safety…' : file.state === 'pending' ? 'Upload incomplete' : file.state === 'rejected' ? file.error || 'Image rejected' : 'Removing image…'}</span>
          {file.state === 'ready' && file.id !== profile.data.avatarId && <button disabled={busy} onClick={() => { void act('publish', { avatarId: file.id, expectedAvatarId: profile.data.avatarId }); }}>Use as avatar</button>}
          {file.state === 'pending' && <button className="button-secondary" disabled={busy} onClick={() => { void check(file.id, 'finalize'); }}>Check uploaded image</button>}
          {file.state === 'uploaded' && file.error && <button className="button-secondary" disabled={busy} onClick={() => { void check(file.id, 'retry'); }}>Retry image checks</button>}
          {file.state !== 'deleting' && <button className="button-secondary" disabled={busy} onClick={() => { void act('remove', { avatarId: file.id }); }}>{file.id === profile.data.avatarId ? 'Remove current avatar' : `Remove ${file.name}`}</button>}
        </li>)}</ul>
      </>}
      {progress !== null && <div role="status">Uploading avatar: {progress}% <progress value={progress} max={100} aria-label="Avatar upload progress" /><button type="button" className="button-secondary" onClick={() => { cancelled.current = true; request.current?.abort(); }}>Cancel avatar upload</button></div>}
      {busy && progress === null && <p role="status">Updating avatar settings…</p>}
      {error && <p role="alert" className="notice error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
    </>}
  </section>;
}
