import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { acceptedMessageSchema, conversationSnapshotSchema, inboxFeedSchema, liveHintSchema, mutationResultSchema, mutationSchema, replayResultSchema, sendMessageSchema, snapshotTicketSchema, snapshotPageSchema } from '@chat/contracts';
import type { AuthSession, ConversationSnapshot, LiveHint, SnapshotPage, SyncInbox } from '@chat/contracts';
import { api, RequestError } from './api.js';
import { queryClient } from './auth-state.js';
import { claimCommand, discardCommand, enqueueCommand, finishCommand, forgetConversation, pendingCommands, readProjection, saveInbox, saveProjection } from './sync-db.js';
import type { PendingCommand, QueuedBody } from './sync-db.js';
export class SyncEngine {
  connected = false; durable = true; version = 0; pending: PendingCommand[] = []; notice = ''; selectedId: string | null = null;
  private socket: Socket; private listeners = new Set<() => void>(); private active = false; private owner = crypto.randomUUID();
  private timer: ReturnType<typeof setTimeout> | undefined; private repairTimer: ReturnType<typeof setTimeout> | undefined;
  private syncing = new Map<string, Promise<ConversationSnapshot>>(); private hints: LiveHint[] = []; private pumping = false; private sending = false; private memory = new Map<string, PendingCommand>();
  private inboxRunning: Promise<SyncInbox> | undefined;
  private channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('commonroom-sync') : null;
  constructor(readonly account: AuthSession, private authFailure: () => void) {
    this.socket = io({ transports: ['websocket'], withCredentials: true, auth: { csrf: account.csrfToken }, autoConnect: false, forceNew: true, reconnectionDelay: 500, reconnectionDelayMax: 3000, timeout: 5000 });
    this.socket.on('connect', () => { this.connected = true; this.changed(); if (this.selectedId) this.subscribe(this.selectedId); void this.repair(); });
    this.socket.on('disconnect', () => { this.connected = false; this.changed(); if (this.active) setTimeout(() => { if (this.active) this.socket.connect(); }, 1000); });
    this.socket.on('connect_error', () => { this.connected = false; this.changed(); });
    this.socket.on('sync:hint', (raw: unknown, acknowledge: unknown) => {
      const parsed = liveHintSchema.safeParse(raw); if (!parsed.success) return;
      if (this.hints.length >= Number(import.meta.env.VITE_LIVE_BUFFER_EVENTS)) { this.hints = []; this.socket.disconnect(); void this.repair(); return; }
      this.hints.push(parsed.data); if (typeof acknowledge === 'function') acknowledge(); void this.pumpHints();
    });
    this.socket.on('sync:reconnect', () => { this.socket.disconnect(); });
    this.socket.on('sync:typing', (raw: { conversationId?: string; active?: boolean; userId?: string }) => { if (raw.conversationId === this.selectedId) window.dispatchEvent(new CustomEvent('commonroom-typing', { detail: raw })); });
    this.channel?.addEventListener('message', event => { if (event.data?.userId === account.user.id && event.data.kind === 'changed') { void this.refreshPending(); void this.repair(); } });
  }
  subscribeState = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() { this.version++; for (const listener of this.listeners) listener(); }
  private broadcast() { this.channel?.postMessage({ kind: 'changed', userId: this.account.user.id }); }
  start() { this.active = true; this.socket.connect(); void this.tick(); void this.repair(); this.scheduleRepair(); }
  stop() { this.active = false; this.socket.disconnect(); this.channel?.close(); if (this.timer) clearTimeout(this.timer); if (this.repairTimer) clearTimeout(this.repairTimer); }
  private scheduleRepair() { this.repairTimer = setTimeout(() => { if (!this.active) return; void this.repair(); this.scheduleRepair(); }, 15000 + Math.floor(Math.random() * 5000)); }
  private subscribe(id: string) { this.socket.timeout(5000).emit('sync:subscribe', { conversationId: id }, () => { if (this.active) void this.synchronize(id).catch(() => {}); }); }
  select(id: string) { this.selectedId = id; if (this.connected) this.subscribe(id); }
  typing(id: string, active: boolean) { if (this.connected) this.socket.volatile.emit('sync:typing', { conversationId: id, active }); }
  async presence(id: string, targetUserId: string): Promise<boolean | null> { if (!this.connected) return null; try { const result = await this.socket.timeout(3000).emitWithAck('sync:presence', { conversationId: id, targetUserId }) as { ok?: boolean; online?: boolean | null }; return result.ok ? result.online ?? null : null; } catch { return null; } }
  async queue(command: QueuedBody) {
    if (!this.active) throw new Error('Check your account before sending.');
    const body = command.type === 'send' ? sendMessageSchema.parse(command.body) : mutationSchema.parse(command.body), id = command.type === 'send' ? (body as ReturnType<typeof sendMessageSchema.parse>).clientMessageId : (body as ReturnType<typeof mutationSchema.parse>).commandId;
    const row: PendingCommand = { key: `${this.account.user.id}:${id}`, userId: this.account.user.id, conversationId: body.conversationId, command, state: 'queued', error: '', attempts: 0, nextAt: 0, owner: null, leaseUntil: 0, createdAt: Date.now() };
    try { await enqueueCommand(row); } catch (error) { if (error instanceof Error && error.message.includes('queue is full')) throw error; this.durable = false; if (this.memory.size >= 100) throw new Error('The local queue is full.', { cause: error }); this.memory.set(row.key, row); }
    if (!this.active) return;
    this.notice = this.durable ? 'Saved on this device. Sending when connected.' : 'Storage unavailable: this pending command exists only in this page.';
    await this.refreshPending(); this.broadcast(); void this.sendNext();
  }
  async discard(key: string) { await discardCommand(this.account.user.id, key).catch(() => {}); this.memory.delete(key); await this.refreshPending(); this.broadcast(); }
  private async refreshPending() { try { this.pending = await pendingCommands(this.account.user.id); } catch { this.durable = false; this.pending = []; } this.pending = [...this.pending, ...this.memory.values()]; this.changed(); }
  private async tick() { if (!this.active) return; await this.refreshPending(); await this.sendNext(); if (this.active) this.timer = setTimeout(() => { void this.tick(); }, 1000); }
  private async sendNext() {
    if (!this.active || this.sending || !navigator.onLine) return; this.sending = true;
    try {
      let row: PendingCommand | undefined;
      try { row = await claimCommand(this.account.user.id, this.owner); } catch { this.durable = false; }
      row ??= [...this.memory.values()].find(item => item.state !== 'failed' && item.nextAt <= Date.now());
      if (!row) return; row.owner = this.owner;
      try {
        const result = await api(row.command.type === 'send' ? '/messages' : '/sync/mutations', { method: 'POST', body: row.command.body, csrf: this.account.csrfToken });
        if (!this.active) return;
        if (row.command.type === 'send') acceptedMessageSchema.parse(result); else mutationResultSchema.parse(result);
        if (this.memory.has(row.key)) this.memory.delete(row.key); else await finishCommand(row);
        if (!this.active) return;
        this.notice = 'Accepted by the server.'; this.broadcast(); await this.synchronize(row.conversationId).catch(() => {});
      } catch (error) {
        if (!this.active) return;
        if (error instanceof RequestError && error.status === 401) { this.authFailure(); return; }
        let lostAccess = false;
        if (error instanceof RequestError && error.status === 403) { try { await api(`/conversations/${row.conversationId}`); } catch { lostAccess = true; } }
        if (lostAccess) { await forgetConversation(this.account.user.id, row.conversationId).catch(() => {}); this.memory.delete(row.key); }
        else {
          const retry = !(error instanceof RequestError) || [0, 408, 429, 503].includes(error.status), message = error instanceof Error ? error.message : 'Result unconfirmed.';
          if (this.memory.has(row.key)) { row.state = retry ? 'queued' : 'failed'; row.error = message; row.attempts++; row.nextAt = Date.now() + 3000; }
          else await finishCommand(row, message, retry);
        }
        this.notice = 'Command not yet confirmed. Pending commands keep their original IDs.';
      }
      await this.refreshPending();
    } finally { this.sending = false; }
  }
  synchronize(id: string): Promise<ConversationSnapshot> {
    const existing = this.syncing.get(id); if (existing) return existing;
    const operation = this.synchronizeOnce(id).finally(() => { this.syncing.delete(id); }); this.syncing.set(id, operation); return operation;
  }
  private async synchronizeOnce(id: string) {
    try {
      let old: Awaited<ReturnType<typeof readProjection>>; try { old = await readProjection(this.account.user.id, id); } catch { this.durable = false; }
      if (old) {
        let after = old.snapshot.watermark, through: string | undefined;
        for (let pages = 0; pages < 3; pages++) {
          try { const page = replayResultSchema.parse(await api(`/sync/conversations/${id}/events?after=${after}${through ? `&through=${through}` : ''}`)); after = page.nextCursor; through = page.watermark; if (!page.hasMore) break; }
          catch (error) { if (!(error instanceof RequestError && error.status === 409)) throw error; break; }
        }
      }
      // The projection and its actual snapshot watermark commit as one IDB record. Hints never advance it.
      let snapshot = conversationSnapshotSchema.parse(await api(`/sync/conversations/${id}/snapshot`)); if (!this.active) return snapshot;
      try { snapshot = await saveProjection(this.account.user.id, snapshot) ?? snapshot; } catch { this.durable = false; }
      if (!this.active) return snapshot;
      queryClient.setQueryData(['chat', this.account.user.id, 'sync', id], snapshot); await queryClient.invalidateQueries({ queryKey: ['chat', this.account.user.id, 'sync', id], predicate: query => query.queryKey.length > 4 }); this.changed(); return snapshot;
    } catch (error) {
      if (error instanceof RequestError && [401, 403].includes(error.status)) { await forgetConversation(this.account.user.id, id).catch(() => {}); queryClient.removeQueries({ queryKey: ['chat', this.account.user.id, 'sync', id] }); if (error.status === 401) this.authFailure(); }
      throw error;
    }
  }
  async olderWindow(id: string, before: string) {
    // Older windows remain memory-only and replace the visible 100 rows; they never advance the latest projection cursor.
    return conversationSnapshotSchema.parse(await api(`/sync/conversations/${id}/snapshot?before=${before}`));
  }
  async repair() {
    if (!this.active || !navigator.onLine) return;
    try { await this.refreshInbox().catch(() => {}); if (this.selectedId) await this.synchronize(this.selectedId); await queryClient.invalidateQueries({ queryKey: ['chat', this.account.user.id, 'detail'] }); }
    catch (error) { if (error instanceof RequestError && error.status === 401) this.authFailure(); }
  }
  refreshInbox(): Promise<SyncInbox> { if (!this.inboxRunning) this.inboxRunning = this.captureInbox().finally(() => { this.inboxRunning = undefined; }); return this.inboxRunning; }
  private async captureInbox() {
    for (let attempt = 0; attempt < 3 && this.active; attempt++) {
    const ticket = snapshotTicketSchema.parse(await api('/sync/snapshots', { method: 'POST', csrf: this.account.csrfToken, body: { kind: 'inbox' } }));
    try {
      const items = []; let page: number | null = 0;
      while (page !== null) { const result: SnapshotPage = snapshotPageSchema.parse(await api(`/sync/snapshots/${ticket.id}?page=${page}`)); if (result.kind !== 'inbox') throw new Error('Unexpected snapshot kind'); items.push(...result.data); page = result.nextPage; }
      let after = ticket.watermark; let changed = false;
      for (let pages = 0; pages < 10; pages++) { const feed = inboxFeedSchema.parse(await api(`/inbox/events?after=${after}`)); changed ||= !!feed.events.length; after = feed.nextCursor; if (!feed.hasMore) break; }
      if (!this.active) throw new Error('Account changed');
      if (!changed) { const accepted = await saveInbox(this.account.user.id, ticket.watermark, items).catch(() => { this.durable = false; return true; }); if (!this.active) throw new Error('Account changed'); if (!accepted) { const saved = queryClient.getQueryData<SyncInbox>(['chat', this.account.user.id, 'inbox']); if (saved) return saved; throw new Error('Newer inbox synchronization is pending.'); } const snapshot = { items, watermark: ticket.watermark }; queryClient.setQueryData(['chat', this.account.user.id, 'inbox'], snapshot); return snapshot; }
    } finally { await api(`/sync/snapshots/${ticket.id}`, { method: 'DELETE', csrf: this.account.csrfToken }).catch(() => {}); }
    }
    this.notice = 'Catching up with inbox changes…'; this.changed(); throw new Error('Inbox changed during capture. Retrying shortly.');
  }
  private async pumpHints() { if (this.pumping) return; this.pumping = true;
    try { while (this.hints.length && this.active) { const batch = this.hints.splice(0, this.hints.length); if (batch.some(hint => hint.kind === 'inbox')) await this.refreshInbox(); if (this.selectedId) await this.synchronize(this.selectedId); await queryClient.invalidateQueries({ queryKey: ['chat', this.account.user.id, 'detail'] }); } }
    catch { /* periodic authoritative repair also runs while the socket remains connected */ }
    finally { this.pumping = false; }
  }
}
