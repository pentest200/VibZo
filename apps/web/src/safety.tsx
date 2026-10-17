import { useState } from 'react';
import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { moderationAccessSchema, notificationSettingsSchema, reportListSchema } from '@chat/contracts';
import type { AuthSession } from '@chat/contracts';
import { api } from './api.js';
import { clearAccount } from './auth-state.js';

export function NotificationSettings({ account }: { account: AuthSession }) {
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(''), [error, setError] = useState('');
  const supported = typeof Notification !== 'undefined' && typeof PushManager !== 'undefined' && 'serviceWorker' in navigator && window.isSecureContext;
  const settings = useQuery({ queryKey: ['notifications', account.user.id], queryFn: async () => notificationSettingsSchema.parse(await api('/safety/notifications')) });
  const mutate = (path: string, method: string, body?: unknown) => api(path, { method, ...(body === undefined ? {} : { body }), csrf: account.csrfToken });
  async function action(operation: () => Promise<void>) { setBusy(true); setNotice(''); setError(''); try { await operation(); await settings.refetch(); } catch (e) { setError(e instanceof Error ? e.message : 'Notification settings unavailable.'); } finally { setBusy(false); } }
  async function enable() {
    if (await Notification.requestPermission() !== 'granted') { setNotice('Notifications were not allowed. Unread messages remain available in Conversations.'); return; }
    const registration = await navigator.serviceWorker.register('/notifications-sw.js'); await navigator.serviceWorker.ready;
    const key = Uint8Array.from(atob(settings.data!.publicKey.replace(/-/g, '+').replace(/_/g, '/')), character => character.charCodeAt(0));
    const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    try { await mutate('/safety/subscriptions', 'POST', subscription.toJSON()); }
    catch (e) { await subscription.unsubscribe(); throw e; }
    setNotice('Notifications enabled on this device. Notices never include message text or names.');
  }
  return <section className="panel" aria-label="Notification settings"><h2>Notifications</h2><p>Unread messages are always available in Conversations. Background delivery depends on your browser and notification service.</p>
    {!supported && <p role="status">Background notifications are unsupported here. Use Conversations for unread messages.</p>}
    {settings.isPending ? <p role="status">Loading notification settings…</p> : settings.isError ? <><p role="alert">Could not load notification settings.</p><button onClick={() => { void settings.refetch(); }}>Retry notification settings</button></> : <>
      {!settings.data.available && <p role="status">Background delivery is unavailable on this server. Use Conversations for unread messages.</p>}
      <p>{settings.data.subscribed ? 'This device is subscribed.' : 'This device is not subscribed.'} {settings.data.enabled ? 'Account notifications are on.' : 'Account notifications are off.'}</p>
      <button disabled={busy || !supported || !settings.data.available || !account.user.verified} onClick={() => { void action(enable); }}>Enable notifications on this device</button>
      {settings.data.subscribed && <button className="button-secondary" disabled={busy} onClick={() => { void action(async () => { await mutate('/safety/subscriptions', 'DELETE'); const registration = await navigator.serviceWorker.getRegistration(); await (await registration?.pushManager.getSubscription())?.unsubscribe(); setNotice('Device notifications disabled.'); }); }}>Disable notifications on this device</button>}
      <button className="button-secondary" disabled={busy || !account.user.verified} onClick={() => { void action(async () => { await mutate('/safety/notifications', 'PATCH', { enabled: !settings.data.enabled }); }); }}>{settings.data.enabled ? 'Pause account notifications' : 'Allow account notifications'}</button>
    </>}{notice && <p className="notice" role="status">{notice}</p>}{error && <p className="notice error" role="alert">{error}</p>}
  </section>;
}
export function ReportButton({ account, conversationId, messageId }: { account: AuthSession; conversationId: string; messageId: string | null }) {
  const [open, setOpen] = useState(false), [reason, setReason] = useState('spam'), [notice, setNotice] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [commandId] = useState(() => crypto.randomUUID());
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await api('/safety/reports', { method: 'POST', csrf: account.csrfToken, body: { commandId, conversationId, messageId, reason } }); setNotice('Report submitted for review.'); setOpen(false); }
    catch (e) { setError(e instanceof Error ? e.message : 'Could not submit report.'); } finally { setBusy(false); }
  }
  return <span><button className="button-secondary" disabled={!!notice} onClick={() => setOpen(value => !value)}>{messageId ? 'Report message' : 'Report conversation'}</button>{open && <form onSubmit={event => { void submit(event); }}><label>Report reason<select value={reason} disabled={busy} onChange={event => setReason(event.target.value)}><option value="spam">Spam</option><option value="harassment">Harassment</option><option value="unsafe">Unsafe content</option><option value="other">Other</option></select></label><p className="hint">Sends a reference and category to moderators. Message text is not copied into the report.</p><button disabled={busy}>Submit report</button></form>}{notice && <span role="status">{notice}</span>}{error && <span role="alert">{error}</span>}</span>;
}
export function ModerationPanel({ account }: { account: AuthSession }) {
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const access = useQuery({ queryKey: ['moderation-access', account.user.id], queryFn: async () => moderationAccessSchema.parse(await api('/safety/moderation/access')) });
  const reports = useQuery({ queryKey: ['reports', account.user.id], enabled: access.data?.allowed ?? false, queryFn: async () => reportListSchema.parse(await api('/safety/moderation/reports')) });
  async function decide(id: string, action: 'remove' | 'dismiss') { setBusy(true); setError(''); try { await api(`/safety/moderation/reports/${id}`, { method: 'POST', csrf: account.csrfToken, body: { action } }); await reports.refetch(); } catch (e) { setError(e instanceof Error ? e.message : 'Decision unavailable.'); } finally { setBusy(false); } }
  if (!access.data?.allowed) return null;
  return <section className="panel" aria-label="Moderation reports"><h2>Report review</h2><p>Restricted references only. Queue access and decisions are audited.</p>{reports.isPending && <p role="status">Loading reports…</p>}{(reports.isError || error) && <p role="alert">{error || 'Report queue unavailable.'}</p>}{!reports.isPending && !reports.data?.length && <p>No open reports.</p>}
    <ul>{reports.data?.map(report => <li key={report.id}><strong>{report.reason}</strong><p>Conversation {report.conversationId}{report.messageId ? ` · Message ${report.messageId}` : ''}</p><button disabled={busy} onClick={() => { void decide(report.id, 'dismiss'); }}>Dismiss report</button>{report.messageId && <button disabled={busy} onClick={() => { void decide(report.id, 'remove'); }}>Remove reported message</button>}</li>)}</ul><button className="button-secondary" disabled={busy} onClick={() => { void reports.refetch(); }}>Refresh reports</button></section>;
}
export function DeleteAccount({ account }: { account: AuthSession }) {
  const navigate = useNavigate(), [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); const values = new FormData(event.currentTarget); setBusy(true); setError('');
    try { await api('/safety/deletion', { method: 'POST', csrf: account.csrfToken, body: { password: values.get('password'), confirmation: values.get('confirmation') } }); clearAccount(); navigate('/login', { replace: true }); }
    catch (e) { setError(e instanceof Error ? e.message : 'Deletion could not be confirmed. Refresh to check your account.'); } finally { setBusy(false); }
  }
  return <section className="panel"><h2>Delete account</h2><p>Signs out every device immediately. Your messages and files are removed from direct and group history as cleanup runs. Other members keep their messages. Groups transfer to a remaining member or close if empty.</p><p className="hint">Restricted pseudonymous audit references and message tombstones remain. Downloaded copies and backups follow separate retention. Cleanup can wait for storage recovery and upload grants to expire.</p><button className="button-secondary" disabled={busy} onClick={() => setOpen(value => !value)}>Delete my account</button>{open && <form onSubmit={event => { void submit(event); }}><label className="field">Confirm deletion password<input name="password" type="password" autoComplete="current-password" required maxLength={128} /></label><label className="field">Type DELETE to confirm<input name="confirmation" required pattern="DELETE" /></label><button disabled={busy}>Permanently delete account</button></form>}{error && <p role="alert">{error}</p>}</section>;
}
