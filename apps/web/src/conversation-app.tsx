import { useEffect, useRef, useState } from 'react';
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
import { Icon, ThemeToggle } from './ui.js';

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
  const [view, setView] = useState<'chats' | 'contacts' | 'group'>('chats'), [unreadOnly, setUnreadOnly] = useState(false);
  const sidebar = useRef<HTMLElement>(null), previousView = useRef(view);
  useEffect(() => { if (previousView.current === view) return; previousView.current = view; if (view !== 'chats') sidebar.current?.querySelector('input')?.focus(); }, [view]);
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
  const allItems = (inbox.data?.items ?? []).filter(item => !unreadOnly || item.unread > 0 || item.state === 'invited'), items = allItems.slice(inboxPage * 50, (inboxPage + 1) * 50);
  useEffect(() => { if (inboxPage * 50 >= allItems.length) setInboxPage(0); }, [allItems.length, inboxPage]);
  async function createGroup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const title = new FormData(event.currentTarget).get('title');
    const result = createdConversationSchema.parse(await command('/conversations/groups', 'POST', { clientCommandId: groupCommand, title }));
    setGroupCommand(crypto.randomUUID()); setView('chats'); navigate(`/chat/${result.conversationId}`);
  }
  return <section className="chat" data-selected={!!id}>
    <a className="skip-link conversation-jump" href="#conversation-pane">Skip to conversation</a>
    <CallDock />
    <div className="chat-grid"><aside ref={sidebar} className="chat-sidebar" aria-label="Conversations and contacts">
      <div className="sidebar-toolbar"><details className="main-menu" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.currentTarget.open = false; event.currentTarget.querySelector('summary')?.focus(); } }}><summary aria-label="Main menu"><Icon name="menu" /></summary><nav aria-label="Main menu" onClick={event => { const menu = event.currentTarget.closest('details'); menu?.removeAttribute('open'); menu?.querySelector('summary')?.focus(); }}><Link to="/account"><Icon name="settings" /> Account & privacy</Link><button onClick={() => setView('contacts')}><Icon name="edit" /> New message</button><button onClick={() => setView('group')}><Icon name="users" /> New group</button><ThemeToggle /></nav></details><h1>Conversations</h1><button className="icon-button" aria-label="Refresh inbox" title="Refresh inbox" disabled={inbox.isFetching} onClick={() => { void inbox.refetch(); }}><Icon name="refresh" size={21} /></button></div>
      {view === 'chats' ? <><button className="sidebar-search" onClick={() => setView('contacts')}><Icon name="search" size={21} /><span>Search people</span></button><div className="chat-tabs" role="group" aria-label="Conversation filter"><button aria-pressed={!unreadOnly} onClick={() => { setUnreadOnly(false); setInboxPage(0); }}>All chats</button><button aria-pressed={unreadOnly} onClick={() => { setUnreadOnly(true); setInboxPage(0); }}>Unread {allItems.reduce((sum, item) => sum + (item.unread > 0 ? 1 : 0), 0) || ''}</button></div>
      <section className="inbox-section"><h2 className="sr-only">Your inbox</h2>
        <ErrorNotice error={inbox.error} />{inbox.isPending && <p role="status">Loading inbox…</p>}
        {!inbox.isPending && !inbox.isError && !items.length && <div className="empty-inbox"><span className="empty-inbox-icon"><Icon name={unreadOnly ? 'check' : 'send'} size={34} /></span><h3>{unreadOnly ? 'You’re all caught up' : 'Your conversations start here'}</h3><p>{unreadOnly ? 'No unread conversations right now.' : 'Find someone by username and say hello.'}</p>{!unreadOnly && <button onClick={() => setView('contacts')}>Start messaging</button>}</div>}
        <ul className="inbox-list">{items.map(item => <li key={item.id}>
          {item.state === 'invited' ? <div className="invitation"><strong>{item.title}</strong><p className="hint">Group invitation</p><div className="control-row"><button disabled={busy} onClick={() => act(async () => { await command(`/conversations/${item.id}/accept`); navigate(`/chat/${item.id}`); })}>Accept {item.title}</button><button className="button-secondary" disabled={busy} onClick={() => act(() => command(`/conversations/${item.id}/decline`))}>Decline {item.title}</button></div></div>
            : <Link className={id === item.id ? 'inbox-link selected' : 'inbox-link'} aria-current={id === item.id ? 'page' : undefined} to={`/chat/${item.id}`}>{item.otherUserId ? <AvatarImage account={account} userId={item.otherUserId} name={item.title} conversationId={item.id} /> : <span className="avatar" aria-hidden="true">{item.title.slice(0, 1).toUpperCase()}</span>}<span className="inbox-copy"><strong>{item.title}</strong><small>{item.kind === 'group' ? `Group · ${item.role}` : 'Direct conversation'}</small></span>{item.unread > 0 && <span className="unread-badge" aria-label={`${item.unread >= 1000 ? '1000+' : item.unread} unread messages`}>{item.unread >= 1000 ? '1000+' : item.unread}</span>}</Link>}
        </li>)}</ul>{inboxPage > 0 && <button className="button-secondary" onClick={() => setInboxPage(inboxPage - 1)}>Previous conversations</button>}{(inboxPage + 1) * 50 < allItems.length && <button className="button-secondary" onClick={() => setInboxPage(inboxPage + 1)}>More conversations</button>}
      </section><div className="sidebar-footer"><SyncStatus /><button className="new-chat-button" aria-label="New message" title="New message" onClick={() => setView('contacts')}><Icon name="edit" /></button><button className="new-group-button" onClick={() => setView('group')}><Icon name="users" size={19} /> New group</button></div>
      <BlockList userId={account.user.id} busy={busy} command={command} act={act} />
      </> : <section className="sidebar-view"><div className="section-heading"><button className="icon-button" aria-label="Back to conversations" onClick={() => setView('chats')}><Icon name="back" /></button><h2>{view === 'contacts' ? 'New message' : 'New group'}</h2></div>{view === 'contacts' ? <><p className="hint">Find a friend by their username.</p><UserSearch userId={account.user.id} busy={busy} onSelect={user => act(async () => { const result = createdConversationSchema.parse(await command('/conversations/direct', 'POST', { targetUserId: user.id })); setView('chats'); navigate(`/chat/${result.conversationId}`); })} label="Open conversation" /></> : <><div className="new-group-art"><Icon name="users" size={46} /></div><p className="hint">A space for your people. Add members after creating your group.</p><form onSubmit={event => act(() => createGroup(event))}><label className="field">Group name<input required maxLength={80} name="title" placeholder="Give your group a name" /></label><button disabled={busy}>Create group</button></form></>}</section>}
      <ErrorNotice error={error} /><p className="sidebar-notice" role="status">{notice}</p>
    </aside><div className="chat-main" id="conversation-pane" tabIndex={-1}>{id ? <Selected key={`${account.user.id}:${id}`} id={id} account={account} command={command} busy={busy} act={act} /> : <section className="chat-welcome"><span className="welcome-orbit"><Icon name="send" size={62} /></span><h2>Your world. One conversation away.</h2><p>Choose a chat to start messaging</p><div className="welcome-features"><span><Icon name="users" size={20} /> Together in groups</span><span><Icon name="phone" size={20} /> Closer with calls</span><span><Icon name="shield" size={20} /> Private conversations</span></div><button onClick={() => setView('contacts')}><Icon name="edit" size={20} /> Start a conversation</button></section>}</div></div></section>;
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
  const [infoOpen, setInfoOpen] = useState(() => c.kind === 'group' && window.matchMedia('(min-width: 1100px)').matches);
  useEffect(() => { const query = window.matchMedia('(min-width: 1100px)'); const closeOnMobile = () => { if (!query.matches) setInfoOpen(false); }; query.addEventListener('change', closeOnMobile); return () => query.removeEventListener('change', closeOnMobile); }, []);
  useEffect(() => { engine.select(c.id); }, [engine, c.id]);
  function reviewed(message: string, operation: () => Promise<unknown>) { if (window.confirm(message)) act(operation); }
  return <div className="conversation-view" data-info={infoOpen}><div className="conversation-heading"><Link className="icon-button mobile-back" aria-label="Back to conversations" to="/chat"><Icon name="back" /></Link><div className="conversation-identity"><button className="icon-button" aria-label="Conversation info" aria-expanded={infoOpen} onClick={() => setInfoOpen(!infoOpen)}><span className="conversation-avatars" role="group" aria-label="Conversation avatars">{c.members.filter(member => member.state === 'active' && member.user.id !== account.user.id).slice(0, 1).map(member => <AvatarImage key={member.user.id} account={account} userId={member.user.id} name={member.user.displayName} conversationId={c.id} />)}{c.members.filter(member => member.state === 'active').length === 1 && <span className="avatar">{c.title.slice(0, 1)}</span>}</span></button><div className="conversation-name"><h1 className="mobile-conversation-title">{c.title}</h1><h2>{c.title}</h2><span className="hint">{c.members.filter(member => member.state === 'active').length} members{c.kind === 'group' ? ` · You are ${c.role}` : ''}</span></div></div><CallLauncher conversationId={c.id} blocked={c.blocked} /><button className="icon-button info-button" aria-label="More conversation options" title="Conversation info" aria-expanded={infoOpen} onClick={() => setInfoOpen(!infoOpen)}><Icon name="more" /></button>{c.kind === 'direct' && c.otherUserId && <button disabled={busy} className="icon-button block-contact-button" aria-label="Block contact" title="Block contact" onClick={() => reviewed('Block this contact? New direct commands will be denied. Shared group membership is unchanged.', () => command(`/blocks/${c.otherUserId}`, 'PUT'))}><Icon name="shield" size={20} /></button>}</div>
    <SyncedHistory conversation={c} account={account} onReply={setReply} />
    {!c.blocked && <MessageComposer key={c.id} id={c.id} account={account} reply={reply} clearReply={() => setReply(null)} />}
    {c.blocked && <div className="blocked-notice"><Icon name="shield" /><p className="notice">New direct contact is unavailable. Previously visible history remains accessible.</p></div>}
    {infoOpen && <aside className="conversation-info" aria-label="Conversation details"><div className="info-heading"><button className="icon-button" aria-label="Close conversation info" onClick={() => setInfoOpen(false)}><Icon name="close" /></button><h2>{c.kind === 'group' ? 'Group info' : 'User info'}</h2></div><div className="info-profile"><span className="profile-initial" aria-hidden="true">{c.title.slice(0, 1).toUpperCase()}</span><h3>{c.title}</h3><p className="hint">{c.kind === 'group' ? 'Group conversation' : 'Direct conversation'} · {c.members.filter(member => member.state === 'active').length} members</p></div>
    {c.kind === 'group' && <details className="chat-section" open><summary>Group settings</summary>
      {manager && <><form key={c.title} onSubmit={event => { event.preventDefault(); const title = new FormData(event.currentTarget).get('title'); act(() => command(`/conversations/${c.id}`, 'PATCH', { title })); }}><label className="field">Group title<input name="title" required maxLength={80} defaultValue={c.title} /></label><button disabled={busy}>Save group name</button></form><h3>Invite a contact</h3><UserSearch userId={account.user.id} busy={busy} label="Invite" onSelect={user => act(() => command(`/conversations/${c.id}/invitations`, 'POST', { targetUserId: user.id }))} /></>}
      <h3>Members & invitations</h3><ul className="member-list">{c.members.map(member => <li key={member.user.id}><div><strong>{member.user.displayName}</strong><small>@{member.user.username} · {member.state === 'invited' ? 'Invitation pending' : member.role}</small>{member.invitationExpiresAt && <small>Expires {new Date(member.invitationExpiresAt).toLocaleString()}</small>}</div>
        {member.user.id !== account.user.id && <div className="control-row">{c.role === 'owner' && member.state === 'active' && <><button className="button-secondary" disabled={busy} onClick={() => act(() => command(`/conversations/${c.id}/members/${member.user.id}`, 'PATCH', { role: member.role === 'admin' ? 'member' : 'admin' }))}>{member.role === 'admin' ? 'Make member' : 'Make admin'} {member.user.username}</button><button className="button-secondary" disabled={busy} onClick={() => reviewed(`Transfer ownership to ${member.user.username}? You will become an admin.`, () => command(`/conversations/${c.id}/owner`, 'POST', { targetUserId: member.user.id }))}>Make owner {member.user.username}</button></>}
          {manager && member.role !== 'owner' && (c.role === 'owner' || member.role !== 'admin') && <button className="button-secondary" disabled={busy} onClick={() => reviewed(`Remove ${member.user.username} from this group?`, () => command(`/conversations/${c.id}/members/${member.user.id}`, 'DELETE'))}>Remove {member.user.username}</button>}
        </div>}</li>)}</ul><p className="hint">Invitations expire after 72 hours by default. Leaving ends history access until you rejoin. Messages from an absence remain hidden. Blocking does not remove shared group members.</p><button className="button-secondary" disabled={busy} onClick={() => reviewed('Leave this group? Owners must transfer ownership before leaving a group with other members.', async () => { await command(`/conversations/${c.id}/leave`); navigate('/chat'); })}>Leave group</button>
    </details>}{c.kind === 'direct' && <div className="chat-section"><h3>Members</h3><ul className="member-list">{c.members.filter(member => member.state === 'active').map(member => <li key={member.user.id}><strong>{member.user.displayName}</strong><small>@{member.user.username}</small></li>)}</ul><p className="hint">Contact privacy and membership determine which profile information is available.</p>{c.otherUserId && <button className="button-secondary" disabled={busy} onClick={() => reviewed('Block this contact? New direct commands will be denied. Shared group membership is unchanged.', () => command(`/blocks/${c.otherUserId}`, 'PUT'))}>Block contact</button>}</div>}</aside>}</div>;
}
