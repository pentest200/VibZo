import { useEffect, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { Routes, Route, Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { authSessionSchema, genericAuthResponseSchema, loginSchema, profileSchema, registerSchema, sessionListSchema } from '@chat/contracts';
import type { AuthSession } from '@chat/contracts';
import { api } from './api.js';
import { accountKey, clearAccount, queryClient, useAccount } from './auth-state.js';
import { ConversationApp } from './conversation-app.js';
import { NotificationSettings, ModerationPanel, DeleteAccount } from './safety.js';
import { AvatarImage, AvatarSettings } from './avatars.js';
import { Icon, ThemeToggle } from './ui.js';
export { queryClient } from './auth-state.js';

// One-use link fragments stay in memory, never HTTP URLs/logs or durable browser storage.
const linkToken = new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '';
if (linkToken) window.history.replaceState(null, '', window.location.pathname);
function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation(), previous = useRef(pathname);
  useEffect(() => {
    const name = pathname.startsWith('/chat') ? 'Conversations' : ({ '/': 'Welcome', '/login': 'Sign in', '/register': 'Create account', '/forgot': 'Password recovery', '/reset': 'Reset password', '/verify': 'Verify email', '/account': 'Account & privacy' } as Record<string, string>)[pathname] ?? 'Page not found';
    document.title = `${name} · Commonroom`;
    if (previous.current !== pathname) document.getElementById('main-content')?.focus();
    previous.current = pathname;
  }, [pathname]);
  const chat = pathname.startsWith('/chat'), settings = pathname === '/account';
  return <div className={`shell ${chat ? 'shell-chat' : settings ? 'shell-settings' : 'shell-auth'}`}><a className="skip-link" href="#main-content">Skip to content</a><header className={chat ? 'app-landmark' : 'site-header'}><Link className="brand" to="/" tabIndex={chat ? -1 : undefined} aria-label="c. Commonroom home"><span className="brand-icon" aria-hidden="true"><Icon name="send" size={25} /></span> Commonroom</Link>{!chat && <span className="stage">A little closer, wherever you are</span>}</header><main id="main-content" tabIndex={-1}>{children}</main><footer className={chat ? 'app-landmark' : ''}>Commonroom · Your conversations, together.</footer></div>;
}
function Notice({ message, error = false }: { message: string; error?: boolean }) {
  return message ? <p className={error ? 'notice error' : 'notice'} role={error ? 'alert' : 'status'}>{message}</p> : null;
}
function Field({ label, name, type = 'text', autoComplete, minLength, value, onChange }: { label: string; name: string; type?: string; autoComplete?: string; minLength?: number; value?: string; onChange?: (value: string) => void }) {
  return <label className="field"><span>{label}</span><input name={name} type={type} required autoComplete={autoComplete} minLength={minLength} maxLength={type === 'password' ? 128 : name === 'email' ? 254 : 60}
    {...(value === undefined ? {} : { value })} onChange={event => onChange?.(event.target.value)} /></label>;
}
function Home() {
  const account = useAccount();
  if (account.data) return <Navigate to={account.data.user.verified ? '/chat' : '/account'} replace />;
  return <><section className="intro"><span className="eyebrow">A place to keep in touch</span><h1>Good conversations<br />start here.</h1><p>One space for the people who matter.<br />Create your account and make yourself at home.</p><div className="actions"><Link className="primary-link" to="/register">Create an account</Link><Link className="secondary-link" to="/login">Sign in</Link></div></section>{account.isError && <Notice message="We couldn’t reach your account. You can try signing in again." error />}</>;
}
function AuthForm({ register = false }: { register?: boolean }) {
  const navigate = useNavigate(); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form); setError(''); setMessage(''); setBusy(true);
    try {
      if (register) {
        const input = registerSchema.safeParse({ email: fields.get('email'), username: fields.get('username'), displayName: fields.get('displayName'), password: fields.get('password') });
        if (!input.success) throw new Error('Use a valid email, a 3–24 character username (letters, numbers, underscore), and a password of at least 12 characters.');
        const response = genericAuthResponseSchema.parse(await api('/auth/register', { method: 'POST', body: input.data })); form.reset(); setMessage(response.message);
      } else {
        const input = loginSchema.parse({ email: fields.get('email'), password: fields.get('password'), deviceLabel: 'Web browser' });
        const result = authSessionSchema.parse(await api('/auth/login', { method: 'POST', body: input })); clearAccount(); queryClient.setQueryData(accountKey, result); navigate('/account');
      }
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Please try again.'); }
    finally { setBusy(false); }
  }
  return <section className="auth-card"><span className="auth-logo" aria-hidden="true"><Icon name="send" size={58} /></span><h1>{register ? 'Create your account' : 'Sign in to Commonroom'}</h1><p>{register ? 'Your next conversation starts here. Verify your email to get chatting.' : 'Welcome back. Your people are one message away.'}</p><form onSubmit={event => { void submit(event); }}>
    <Field label="Email" name="email" type="email" autoComplete="email" />{register && <><Field label="Username" name="username" autoComplete="username" /><Field label="Display name" name="displayName" autoComplete="nickname" /></>}
    <Field label="Password" name="password" type="password" autoComplete={register ? 'new-password' : 'current-password'} {...(register ? { minLength: 12 } : {})} />{register && <p className="hint">At least 12 characters. Choose a password you don’t use elsewhere.</p>}
    <Notice message={error} error /><Notice message={message} /><button disabled={busy} type="submit">{busy ? 'One moment…' : register ? 'Create account' : 'Sign in'}</button>
  </form><div className="form-links">{register ? <Link to="/login">Already have an account? Sign in</Link> : <><Link to="/forgot">Forgot your password?</Link><Link to="/register">Create an account</Link></>}</div></section>;
}
function ForgotPassword() {
  const [message, setMessage] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const email = new FormData(event.currentTarget).get('email'); setBusy(true); setError('');
    try { setMessage(genericAuthResponseSchema.parse(await api('/auth/reset/request', { method: 'POST', body: { email } })).message); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Please try again.'); } finally { setBusy(false); }
  }
  return <section className="auth-card"><h1>A fresh start.</h1><p>We’ll email a password reset link if the account is eligible.</p><form onSubmit={event => { void submit(event); }}><Field label="Email" name="email" type="email" autoComplete="email" /><Notice message={error} error /><Notice message={message} /><button disabled={busy}>Send reset link</button></form><Link to="/login">Back to sign in</Link></section>;
}
function TokenForm({ reset = false }: { reset?: boolean }) {
  const [token, setToken] = useState(linkToken);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    const capture = () => {
      const incoming = new URLSearchParams(window.location.hash.slice(1)).get('token');
      if (!incoming) return;
      window.history.replaceState(null, '', window.location.pathname);
      setToken(incoming); setMessage(''); setError('');
    };
    window.addEventListener('hashchange', capture);
    return () => window.removeEventListener('hashchange', capture);
  }, []);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const password = new FormData(event.currentTarget).get('password'); setBusy(true); setError('');
    try { setMessage(genericAuthResponseSchema.parse(await api(reset ? '/auth/reset/confirm' : '/auth/verify', { method: 'POST', body: reset ? { token, password } : { token } })).message); setToken(''); clearAccount(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Please try again.'); } finally { setBusy(false); }
  }
  return <section className="auth-card"><h1>{reset ? 'Choose a new password.' : 'Confirm your email.'}</h1>{message ? <Notice message={message} /> : !token ? <Notice message="This link has no token. Open the link from your email again." error /> : <form onSubmit={event => { void submit(event); }}>{reset && <Field label="New password" name="password" type="password" autoComplete="new-password" minLength={12} />}<Notice message={error} error /><button disabled={busy}>{reset ? 'Reset password' : 'Verify email'}</button></form>}<Link to="/login">Continue to sign in</Link></section>;
}
function Account() {
  const account = useAccount(); const navigate = useNavigate(); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [busy, setBusy] = useState(false);
  const sessions = useQuery({ queryKey: ['active-sessions', account.data?.user.id], queryFn: async () => sessionListSchema.parse(await api('/sessions')), enabled: !!account.data });
  async function action(operation: () => Promise<void>) {
    setBusy(true); setError(''); setMessage('');
    try { await operation(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Please try again.'); } finally { setBusy(false); }
  }
  const current = account.data;
  if (account.isPending) return <section className="auth-card" role="status">Loading your account…</section>;
  if (account.isError) return <section className="auth-card"><Notice message="Your account is unavailable. Please reconnect and try again." error /><button onClick={() => { void account.refetch(); }}>Try again</button></section>;
  if (!current) return <Navigate to="/login" replace />;
  const mutation = async (path: string, method = 'POST', body: unknown = {}) => api(path, { method, body, csrf: current.csrfToken });
  const signOut = async (all = false) => { await mutation(all ? '/sessions/all' : '/auth/logout', all ? 'DELETE' : 'POST'); clearAccount(); navigate('/login'); };
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    await action(async () => {
      const user = profileSchema.parse(await mutation('/me', 'PATCH', { username: values.get('username'), displayName: values.get('displayName'), privacy: { showPresence: values.get('showPresence') === 'on', allowSearch: values.get('allowSearch') === 'on' } }));
      queryClient.setQueryData<AuthSession>(accountKey, { ...current!, user }); setMessage('Profile saved.');
    });
  }
  async function password(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const values = new FormData(event.currentTarget);
    await action(async () => { await mutation('/auth/password', 'POST', { currentPassword: values.get('currentPassword'), password: values.get('password') }); clearAccount(); navigate('/login'); });
  }
  return <section className="account"><nav className="settings-nav" aria-label="Settings navigation"><Link className="settings-back" to={current.user.verified ? '/chat' : '/'}><Icon name="back" />{current.user.verified ? 'Back to chats' : 'Commonroom'}</Link><h2>Settings</h2><a href="#profile"><Icon name="users" /> My profile</a><a href="#security"><Icon name="shield" /> Privacy and security</a><a href="#devices"><Icon name="phone" /> Devices</a><ThemeToggle /><span className="settings-version">Commonroom Web</span></nav><div className="settings-content"><div className="account-heading"><div className="account-identity"><span className="account-avatar"><AvatarImage account={current} userId={current.user.id} name={current.user.displayName} avatarId={current.user.avatarId} /></span><span className="eyebrow">Your account</span><h1>Hello, {current.user.displayName}.</h1><p className="hint">@{current.user.username}</p></div><button className="button-secondary" disabled={busy} onClick={() => { void action(() => signOut()); }}>Sign out</button></div>{current.user.verified && <Link className="primary-link account-chat-link" to="/chat"><Icon name="send" size={20} /> Open conversations</Link>}<Notice message={error} error /><Notice message={message} />
    {!current.user.verified && <div className="verification"><h2>Verify your email</h2><p>Open the link we sent to {current.user.email}. This helps protect your account.</p><button disabled={busy} onClick={() => { void action(async () => { await mutation('/auth/verify/request'); setMessage('If eligible, a new verification email is on its way.'); }); }}>Send a new verification email</button></div>}
    <div className="account-grid"><section className="panel" id="profile"><h2>Profile & privacy</h2><p className="hint">{current.user.email} · {current.user.verified ? 'Email verified' : 'Awaiting verification'}</p><form onSubmit={event => { void save(event); }} key={current.user.username}><ProfileFields current={current} /><Notice message="Search privacy applies to new contacts. Online presence is approximate and follows your privacy setting." /><button disabled={busy}>Save profile</button></form></section><AvatarSettings key={current.user.id} account={current} />
    <section className="panel" id="devices"><h2>Active sessions</h2>{sessions.isPending ? <p role="status">Loading sessions…</p> : sessions.isError ? <><Notice message="Couldn’t load sessions." error /><button onClick={() => { void sessions.refetch(); }}>Retry</button></> : <ul className="sessions">{sessions.data?.map(session => <li key={session.id}><div><strong>{session.deviceLabel}</strong><p>{session.current ? 'This device' : 'Another device'} · Started {new Date(session.createdAt).toLocaleDateString()}</p></div><button className="button-secondary" disabled={busy} onClick={() => { void action(async () => { await mutation(`/sessions/${session.id}`, 'DELETE'); if (session.current) { clearAccount(); navigate('/login'); } else await sessions.refetch(); }); }}>Sign out {session.current ? 'this device' : 'session'}</button></li>)}</ul>}<button disabled={busy} onClick={() => { void action(() => signOut(true)); }}>Sign out all devices</button></section>
    <section className="panel" id="security"><h2>Change password</h2><p className="hint">Changing your password signs out every device.</p><form onSubmit={event => { void password(event); }}><Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" /><Field label="New password" name="password" type="password" minLength={12} autoComplete="new-password" /><button disabled={busy}>Change password</button></form></section>
    <section className="panel coming"><span className="eyebrow">Your people</span><h2>A place for your conversations.</h2><p>{current.user.verified ? 'Your chats are ready. Open conversations above to find a contact or create a group.' : 'Verify your email to unlock chats, contacts and groups. Open the verification link in your inbox, then return here.'}</p></section><NotificationSettings account={current} /><ModerationPanel account={current} /><DeleteAccount account={current} /></div></div></section>;
}
function ProfileFields({ current }: { current: AuthSession }) {
  const [username, setUsername] = useState(current.user.username); const [displayName, setDisplayName] = useState(current.user.displayName);
  return <><Field label="Display name" name="displayName" autoComplete="nickname" value={displayName} onChange={setDisplayName} /><Field label="Username" name="username" autoComplete="username" value={username} onChange={setUsername} /><label className="check"><input type="checkbox" name="showPresence" defaultChecked={current.user.privacy.showPresence} /> Show when I’m online</label><label className="check"><input type="checkbox" name="allowSearch" defaultChecked={current.user.privacy.allowSearch} /> Allow people to find my username</label></>;
}
export function App() {
  return <Layout><Routes><Route path="/" element={<Home />} /><Route path="/login" element={<AuthForm />} /><Route path="/register" element={<AuthForm register />} /><Route path="/forgot" element={<ForgotPassword />} /><Route path="/verify" element={<TokenForm />} /><Route path="/reset" element={<TokenForm reset />} /><Route path="/account" element={<Account />} /><Route path="/chat" element={<ConversationApp />} /><Route path="/chat/:id" element={<ConversationApp />} /><Route path="*" element={<section className="auth-card"><h1>Page not found</h1><Link to="/">Return home</Link></section>} /></Routes></Layout>;
}
