import { openDB } from 'idb';
import type { DBSchema } from 'idb';
import type { ConversationSnapshot, MessageMutation, SendMessage } from '@chat/contracts';
export type QueuedBody = { type: 'send'; body: SendMessage } | { type: 'mutation'; body: MessageMutation };
export interface PendingCommand { key: string; userId: string; conversationId: string; command: QueuedBody; state: 'queued' | 'sending' | 'failed'; error: string; attempts: number; nextAt: number; owner: string | null; leaseUntil: number; createdAt: number }
interface Projection { key: string; userId: string; snapshot: ConversationSnapshot; touchedAt?: number }
interface Inbox { key: string; userId: string; cursor: string; items: unknown[] }
interface LocalDB extends DBSchema { projections: { key: string; value: Projection }; inbox: { key: string; value: Inbox }; pending: { key: string; value: PendingCommand; indexes: { 'by-user': string } } }
let epoch = 0;
let database: ReturnType<typeof open> | undefined;
function open() { return openDB<LocalDB>('commonroom-sync-v1', 1, { upgrade(db) { db.createObjectStore('projections', { keyPath: 'key' }); db.createObjectStore('inbox', { keyPath: 'key' }); const pending = db.createObjectStore('pending', { keyPath: 'key' }); pending.createIndex('by-user', 'userId'); } }); }
const db = () => database ??= open().catch(error => { database = undefined; throw error; });
export async function clearPrivateStore() {
  epoch++; try { const store = await db(), tx = store.transaction(['projections', 'inbox', 'pending'], 'readwrite'); await Promise.all([tx.objectStore('projections').clear(), tx.objectStore('inbox').clear(), tx.objectStore('pending').clear()]); await tx.done; } catch { /* storage denial is surfaced by the sync engine */ }
}
export async function readProjection(userId: string, id: string) { return (await db()).get('projections', `${userId}:${id}`); }
export async function saveProjection(userId: string, snapshot: ConversationSnapshot) {
  const current = epoch, store = await db(); if (current !== epoch) return;
  const tx = store.transaction('projections', 'readwrite'), key = `${userId}:${snapshot.conversationId}`, old = await tx.store.get(key);
  const accepted = old && BigInt(old.snapshot.watermark) > BigInt(snapshot.watermark) ? old.snapshot : snapshot;
  await tx.store.put({ key, userId, snapshot: accepted, touchedAt: Date.now() });
  const rows = (await tx.store.getAll()).filter(row => row.userId === userId && row.key !== key).sort((a, b) => (b.touchedAt ?? 0) - (a.touchedAt ?? 0));
  for (const row of rows.slice(9)) await tx.store.delete(row.key);
  await tx.done; return accepted;
}
export async function saveInbox(userId: string, cursor: string, items: unknown[]) {
  const current = epoch, store = await db(); if (current !== epoch) return false;
  const tx = store.transaction('inbox', 'readwrite'), old = await tx.store.get(userId);
  const accepted = !old || BigInt(old.cursor) <= BigInt(cursor);
  if (accepted) await tx.store.put({ key: userId, userId, cursor, items }); await tx.done; return accepted;
}
export async function pendingCommands(userId: string) { return (await db()).getAllFromIndex('pending', 'by-user', userId); }
export async function enqueueCommand(row: PendingCommand) {
  const current = epoch, store = await db(); if (current !== epoch) throw new Error('Account changed');
  const tx = store.transaction('pending', 'readwrite'); if (await tx.store.index('by-user').count(row.userId) >= 100) { tx.abort(); throw new Error('The local queue is full. Reconnect before sending more.'); } await tx.store.put(row); await tx.done;
}
export async function claimCommand(userId: string, owner: string) {
  const store = await db(), tx = store.transaction('pending', 'readwrite'), rows = await tx.store.index('by-user').getAll(userId), now = Date.now();
  const row = rows.sort((a, b) => a.createdAt - b.createdAt).find(row => row.state !== 'failed' && row.nextAt <= now && row.leaseUntil <= now);
  if (row) { row.owner = owner; row.leaseUntil = now + 30000; row.state = 'sending'; await tx.store.put(row); } await tx.done; return row;
}
export async function finishCommand(row: PendingCommand, error?: string, retry = false) {
  const store = await db(), tx = store.transaction('pending', 'readwrite'), saved = await tx.store.get(row.key);
  if (saved?.owner === row.owner) {
    if (!error) await tx.store.delete(row.key);
    else { saved.error = error; saved.attempts++; saved.owner = null; saved.leaseUntil = 0; saved.state = retry ? 'queued' : 'failed'; saved.nextAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(saved.attempts, 5)); await tx.store.put(saved); }
  } await tx.done;
}
export async function forgetConversation(userId: string, id: string) { const store = await db(), tx = store.transaction(['projections', 'pending'], 'readwrite'); await tx.objectStore('projections').delete(`${userId}:${id}`); for (const row of await tx.objectStore('pending').index('by-user').getAll(userId)) if (row.conversationId === id) await tx.objectStore('pending').delete(row.key); await tx.done; }
export async function discardCommand(userId: string, key: string) { const store = await db(), tx = store.transaction('pending', 'readwrite'), row = await tx.store.get(key); if (row?.userId === userId && row.leaseUntil <= Date.now()) await tx.store.delete(key); await tx.done; }
