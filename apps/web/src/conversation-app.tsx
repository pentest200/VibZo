import { useEffect, useState } from 'react';
import { AvatarImage } from './avatars.js';
import type { FormEvent } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { blocksSchema, conversationSchema, createdConversationSchema, searchQuerySchema, searchResultSchema } from '@chat/contracts';
import type { AuthSession, Conversation, PublicUser } from '@chat/contracts';
import { api } from './api.js';
import { queryClient, useAccount } from './auth-state.js';
import { MessageComposer } from './message-composer.js';
import type { ReplyTarget } from './message-composer.js';
import { SyncProvider, SyncStatus, useSyncEngine } from './sync-context.js';
import { SyncedHistory } from './synced-history.js';
import { CallUIProvider, CallDock, CallLauncher } from './calls.js';

const failureMessage = (error: unknown) => error instanceof Error ? error.message : 'Please try again.';
function ErrorNotice({ error }: { error: unknown }) { return error ? <p className="notice error" role="alert">{failureMessage(error)}</p> : null; }
type Command = (path: string, method?: string, body?: unknown) => Promise<unknown>;

export function ConversationApp() {
  const account = useAccount();
  if (account.isPending) return <p role="status">Loading your account…</p>;
  if (account.isError) return <><ErrorNotice error={account.error} /><button onClick={() => { void account.refetch(); }}>Retry account</button></>;
  if (!account.data) return <Navigate to="/login" replace />;
  if (!account.data.user.verified) return <Navigate to="/account" replace />;
  return <SyncProvider account={account.data}><CallUIProvider account={account.data}><Chat key={account.data.user.id} account={account.data} /></CallUIProvider></SyncProvider>;
}
function Chat({ account }: { account: AuthSession }) {
  const { id } = useParams(); const navigate = useNavigate();
  const [error, setError] = useState<unknown>(null); const [busy, setBusy] = useState(false); const [notice, setNotice] = useState('');
  const [groupCommand, setGroupCommand] = useState(() => crypto.randomUUID());
  const engine = useSyncEngine(), [inboxPage, setInboxPage] = useState(0);
  const inbox = useQuery({ queryKey: ['chat', account.user.id, 'inbox'], queryFn: () => engine.refreshInbox(), refetchInterval: 20000 });
  const command: Command = async (path, method = 'POST', body = {}) => {
    setBusy(true); setError(null); setNotice('');
    try {
      const result = await api(path, { method, body, csrf: account.csrfToken });
      await queryClient.invalidateQueries({ queryKey: ['chat', account.user.id] });
      setNotice('Saved.'); return result;
    } catch (error) { setError(error); throw error; } finally { setBusy(false); }
  };
  const act = (operation: () => Promise<unknown>) => { void operation().catch(() => {}); };
  const allItems = inbox.data?.items ?? [], items = allItems.slice(inboxPage * 50, (inboxPage + 1) * 50);
  useEffect(() => { if (inboxPage * 50 >= allItems.length) setInboxPage(0); }, [allItems.length, inboxPage]);
  async function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const title = new FormData(event.currentTarget).get('title');
    const result = createdConversationSchema.parse(await command('/conversations/groups', 'POST', { clientCommandId: groupCommand, title }));
    setGroupCommand(crypto.randomUUID()); navigate(`/chat/${result.conversationId}`);
  }
  return <section className="chat"><div className="chat-heading"><div><span className="eyebrow">Your Commonroom</span><h1>Conversations</h1></div><Link to="/account">Account & privacy</Link></div>
    <a className="secondary-link conversation-jump" href="#conversation-pane">Skip to conversation</a><SyncStatus /><CallDock /><ErrorNotice error={error} /><p className="notice" role="status">{notice}</p>
    <div className="chat-grid"><aside className="chat-sidebar" aria-label="Conversations and contacts">
      <section className="chat-section"><div className="section-heading"><h2>Your inbox</h2><button className="button-secondary" disabled={inbox.isFetching} onClick={() => { void inbox.refetch(); }}>Refresh inbox</button></div><p className="hint">Live updates with periodic recovery.</p>
        <ErrorNotice error={inbox.error} />{inbox.isPending && <p role="status">Loading inbox…</p>}
        {!inbox.isPending && !inbox.isError && !items.length && <p className="empty-copy">Your people will appear here. Find a contact or start a group below.</p>}
        <ul className="inbox-list">{items.map(item => <li key={item.id}>
          {item.state === 'invited' ? <div className="invitation"><strong>{item.title}</strong><p className="hint">Group invitation</p><div className="control-row"><button disabled={busy} onClick={() => act(async () => { await command(`/conversations/${item.id}/accept`); navigate(`/chat/${item.id}`); })}>Accept {item.title}</button><button className="button-secondary" disabled={busy} onClick={() => act(() => command(`/conversations/${item.id}/decline`))}>Decline {item.title}</button></div></div>
            : <Link className={id === item.id ? 'inbox-link selected' : 'inbox-link'} aria-current={id === item.id ? 'page' : undefined} to={`/chat/${item.id}`}>{item.otherUserId ? <AvatarImage account={account} userId={item.otherUserId} name={item.title} conversationId={item.id} /> : <span className="avatar" aria-hidden="true">{item.title.slice(0, 1).toUpperCase()}</span>}<span><strong>{item.title}</strong>{item.unread > 0 && <small aria-label={`${item.unread >= 1000 ? '1000+' : item.unread} unread messages`}>{item.unread >= 1000 ? '1000+' : item.unread} unread</small>}<small>{item.kind === 'group' ? `Group · ${item.role}` : 'Direct conversation'}</small></span></Link>}
        </li>)}</ul>{inboxPage > 0 && <button className="button-secondary" onClick={() => setInboxPage(inboxPage - 1)}>Previous conversations</button>}{(inboxPage + 1) * 50 < allItems.length && <button className="button-secondary" onClick={() => setInboxPage(inboxPage + 1)}>More conversations</button>}
      </section>
      <section className="chat-section"><h2>Find your people</h2><UserSearch userId={account.user.id} busy={busy} onSelect={user => act(async () => { const result = createdConversationSchema.parse(await command('/conversations/direct', 'POST', { targetUserId: user.id })); navigate(`/chat/${result.conversationId}`); })} label="Open conversation" /></section>
      <section className="chat-section"><h2>Start a group</h2><form onSubmit={event => act(() => createGroup(event))}><label className="field">Group name<input required maxLength={80} name="title" /></label><button disabled={busy}>Create group</button></form></section>
      <BlockList userId={account.user.id} busy={busy} command={command} act={act} />
    </aside><div className="chat-main" id="conversation-pane" tabIndex={-1}>{id ? <Selected key={`${account.user.id}:${id}`} id={id} account={account} command={command} busy={busy} act={act} /> : <section className="chat-welcome"><span className="brand-icon" aria-hidden="true">c.</span><h2>Make room for your people.</h2><p>Open a conversation or create a group to get started.</p><p className="hint">Send text and replies, manage invitations, and keep your people close. Voice and video calls are available when calling is enabled.</p></section>}</div></div></section>;
}
function UserSearch({ userId, busy, onSelect, label }: { userId: string; busy: boolean; onSelect: (user: PublicUser) => void; label: string }) {
  const [prefix, setPrefix] = useState(''); const [error, setError] = useState('');
  const users = useInfiniteQuery({ queryKey: ['chat', userId, 'search', prefix], initialPageParam: '', enabled: !!prefix,
    queryFn: async ({ pageParam }) => searchResultSchema.parse(await api(`/users?prefix=${encodeURIComponent(prefix)}&limit=10${pageParam ? `&after=${pageParam}` : ''}`)), getNextPageParam: page => page.nextCursor ?? undefined });
  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const parsed = searchQuerySchema.safeParse({ prefix: new FormData(event.currentTarget).get('prefix') });
    setError(parsed.success ? '' : 'Enter 3–24 username characters, starting with a letter.'); if (parsed.success) { setPrefix(parsed.data.prefix); if (parsed.data.prefix === prefix) void users.refetch(); }
  }
  return <><form onSubmit={search}><label className="field">Username prefix<input name="prefix" required minLength={3} maxLength={24} autoComplete="off" /></label><button className="button-secondary">Search people</button></form>{error && <p role="alert" className="notice error">{error}</p>}<ErrorNotice error={users.error} />
    {prefix && users.isFetching && <p role="status">Searching…</p>}<ul className="people-list">{users.data?.pages.flatMap(page => page.users).map(user => <li key={user.id}><span><strong>{user.displayName}</strong><small>@{user.username}</small></span><button disabled={busy} onClick={() => onSelect(user)} aria-label={`${label} with ${user.username}`}>{label}</button></li>)}</ul>
    {prefix && users.isSuccess && !users.data.pages.some(page => page.users.length) && <p className="hint">No discoverable contacts on this page.</p>}{users.hasNextPage && <button className="button-secondary" disabled={users.isFetching} onClick={() => { void users.fetchNextPage(); }}>More people</button>}</>;
}
function BlockList({ userId, command, busy, act }: { userId: string; command: Command; busy: boolean; act: (operation: () => Promise<unknown>) => void }) {
  const blocks = useInfiniteQuery({ queryKey: ['chat', userId, 'blocks'], initialPageParam: '', queryFn: async ({ pageParam }) => blocksSchema.parse(await api(`/blocks?limit=20${pageParam ? `&after=${pageParam}` : ''}`)), getNextPageParam: page => page.nextCursor ?? undefined, refetchInterval: 10000 });
  return <details className="chat-section"><summary>Blocked contacts</summary><ErrorNotice error={blocks.error} /><ul className="people-list">{blocks.data?.pages.flatMap(page => page.users).map(user => <li key={user.id}><span>{user.displayName}<small>@{user.username}</small></span><button className="button-secondary" disabled={busy} onClick={() => act(() => command(`/blocks/${user.id}`, 'DELETE'))}>Unblock {user.username}</button></li>)}</ul>{blocks.isSuccess && !blocks.data.pages.some(page => page.users.length) && <p className="hint">You have no blocked contacts.</p>}{blocks.hasNextPage && <button onClick={() => { void blocks.fetchNextPage(); }} disabled={blocks.isFetching}>More blocked contacts</button>}</details>;
}
function Selected({ id, account, command, busy, act }: { id: string; account: AuthSession; command: Command; busy: boolean; act: (operation: () => Promise<unknown>) => void }) {
  const detail = useQuery({ queryKey: ['chat', account.user.id, 'detail', id], queryFn: async () => conversationSchema.parse(await api(`/conversations/${id}`)), refetchInterval: 10000 });
  // A failed authorization hides all cached private detail/history immediately.
  if (detail.isPending || !detail.isFetchedAfterMount) return <p className="chat-section" role="status">Opening conversation…</p>;
  if (detail.isError) return <section className="chat-section"><h2>Conversation unavailable</h2><ErrorNotice error={detail.error} /><button onClick={() => { void detail.refetch(); }}>Retry conversation</button><p className="hint">You may need to accept an invitation, or your membership may have ended.</p></section>;
  return <ConversationPanel conversation={detail.data} account={account} command={command} busy={busy} act={act} />;
}
function ConversationPanel({ conversation: c, account, command, busy, act }: { conversation: Conversation; account: AuthSession; command: Command; busy: boolean; act: (operation: () => Promise<unknown>) => void }) {
  const navigate = useNavigate(); const manager = c.kind === 'group' && c.role !== 'member';
  const [reply, setReply] = useState<ReplyTarget | null>(null); const engine = useSyncEngine();
  useEffect(() => { engine.select(c.id); }, [engine, c.id]);
  function reviewed(message: string, operation: () => Promise<unknown>) { if (window.confirm(message)) act(operation); }
  return <><div className="conversation-heading"><span className="eyebrow">{c.kind === 'group' ? 'Group conversation' : 'Direct conversation'}</span><h2>{c.title}</h2><div className="conversation-avatars" role="group" aria-label="Conversation avatars">{c.members.filter(member => member.state === 'active' && member.user.id !== account.user.id).map(member => <AvatarImage key={member.user.id} account={account} userId={member.user.id} name={member.user.displayName} conversationId={c.id} />)}</div><p className="hint">{c.members.filter(member => member.state === 'active').length} members{c.kind === 'group' ? ` · You are ${c.role}` : ''}</p></div>
    <SyncedHistory conversation={c} account={account} onReply={setReply} />
    {!c.blocked && <MessageComposer key={c.id} id={c.id} account={account} reply={reply} clearReply={() => setReply(null)} />}
    <div className="chat-section"><CallLauncher conversationId={c.id} blocked={c.blocked} />{c.blocked && <p className="notice">New direct contact is unavailable. Previously visible history remains accessible.</p>}
      {c.kind === 'direct' && c.otherUserId && <button disabled={busy} className="button-secondary" onClick={() => reviewed('Block this contact? New direct commands will be denied. Shared group membership is unchanged.', () => command(`/blocks/${c.otherUserId}`, 'PUT'))}>Block contact</button>}
    </div>
    {c.kind === 'group' && <details className="chat-section" open><summary>Group settings</summary>
      {manager && <><form key={c.title} onSubmit={event => { event.preventDefault(); const title = new FormData(event.currentTarget).get('title'); act(() => command(`/conversations/${c.id}`, 'PATCH', { title })); }}><label className="field">Group title<input name="title" required maxLength={80} defaultValue={c.title} /></label><button disabled={busy}>Save group name</button></form><h3>Invite a contact</h3><UserSearch userId={account.user.id} busy={busy} label="Invite" onSelect={user => act(() => command(`/conversations/${c.id}/invitations`, 'POST', { targetUserId: user.id }))} /></>}
      <h3>Members & invitations</h3><ul className="member-list">{c.members.map(member => <li key={member.user.id}><div><strong>{member.user.displayName}</strong><small>@{member.user.username} · {member.state === 'invited' ? 'Invitation pending' : member.role}</small>{member.invitationExpiresAt && <small>Expires {new Date(member.invitationExpiresAt).toLocaleString()}</small>}</div>
        {member.user.id !== account.user.id && <div className="control-row">{c.role === 'owner' && member.state === 'active' && <><button className="button-secondary" disabled={busy} onClick={() => act(() => command(`/conversations/${c.id}/members/${member.user.id}`, 'PATCH', { role: member.role === 'admin' ? 'member' : 'admin' }))}>{member.role === 'admin' ? 'Make member' : 'Make admin'} {member.user.username}</button><button className="button-secondary" disabled={busy} onClick={() => reviewed(`Transfer ownership to ${member.user.username}? You will become an admin.`, () => command(`/conversations/${c.id}/owner`, 'POST', { targetUserId: member.user.id }))}>Make owner {member.user.username}</button></>}
          {manager && member.role !== 'owner' && (c.role === 'owner' || member.role !== 'admin') && <button className="button-secondary" disabled={busy} onClick={() => reviewed(`Remove ${member.user.username} from this group?`, () => command(`/conversations/${c.id}/members/${member.user.id}`, 'DELETE'))}>Remove {member.user.username}</button>}
        </div>}</li>)}</ul><p className="hint">Invitations expire after 72 hours by default. Leaving ends history access until you rejoin. Messages from an absence remain hidden. Blocking does not remove shared group members.</p><button className="button-secondary" disabled={busy} onClick={() => reviewed('Leave this group? Owners must transfer ownership before leaving a group with other members.', async () => { await command(`/conversations/${c.id}/leave`); navigate('/chat'); })}>Leave group</button>
    </details>}</>;
}
