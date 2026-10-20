import { randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { io } from 'socket.io-client';
import type { Socket } from 'socket.io-client';
import { acceptedReferenceSchema, conversationSnapshotSchema, liveHintSchema, replayResultSchema } from '@chat/contracts';
import type { AcceptedMessage } from '@chat/contracts';
import type { APIRequestContext } from '@playwright/test';
import { actor, group, post } from './actors.js';
import type { Actor } from './actors.js';
import { budget, distribution, profiles } from './policy.js';
import type { Profile } from './policy.js';

interface Sent { actor: Actor; conversationId: string; command: { v: 1; conversationId: string; clientMessageId: string; text: string; attachmentIds: never[] }; result: AcceptedMessage; started: number; measured: boolean }
interface View { actor: Actor; conversationId: string; cursor: string; applied: Map<string, number>; socket: Socket | null; running: Promise<void> | undefined; dirty: boolean; offline: boolean }
async function until(check: () => boolean, guard: () => void) { const end = performance.now() + 15000; while (!check()) { guard(); if (performance.now() > end) throw new Error('Load live/replay deadline'); await pause(25); } }
export async function chatLoad(request: APIRequestContext, profile: Profile, guard: () => void) {
  const shape = profiles[profile], actors: Actor[] = [], views: View[] = [], sent: Sent[] = [], ackMs: number[] = [], schedulingMs: number[] = [], duplicateMs: number[] = [];
  let failure: string | null = null, stopping = false, offered = 0, dropped = 0, measuredOffered = 0, index = 0, measuredStart = 0, measuredEnd = 0;
  const check = () => { guard(); if (failure) throw new Error(failure); };
  const replay = async (view: View) => {
    for (let pages = 0; pages < 8; pages++) {
      const response = await view.actor.api.get(`/api/v1/sync/conversations/${view.conversationId}/events?after=${view.cursor}&limit=100`);
      if (response.status() !== 200) throw new Error('replay_http');
      const page = replayResultSchema.parse(await response.json()); let last = BigInt(view.cursor);
      for (const event of page.events) {
        if (BigInt(event.sequence) <= last || view.applied.has(event.eventId)) throw new Error('replay_order_or_duplicate');
        last = BigInt(event.sequence); view.applied.set(event.eventId, performance.now());
        if (view.applied.size > 512) throw new Error('replay_event_budget');
      }
      if (BigInt(page.nextCursor) < last || page.hasMore && page.nextCursor === view.cursor) throw new Error('replay_cursor');
      view.cursor = page.nextCursor; if (!page.hasMore) return;
    }
    throw new Error('replay_page_budget');
  };
  function refresh(view: View) {
    view.dirty = true;
    return view.running ??= (async () => { try { while (view.dirty) { view.dirty = false; await replay(view); } } catch { failure ??= 'replay_failure'; } finally { view.running = undefined; } })();
  }
  async function connect(view: View) {
    const socket = io('http://127.0.0.1:3001', { transports: ['websocket'], forceNew: true, reconnection: false, timeout: 5000, auth: { csrf: view.actor.csrf }, extraHeaders: { Origin: 'http://localhost:5173', Cookie: view.actor.cookie } });
    view.socket = socket;
    socket.on('sync:hint', (raw: unknown, ack: () => void) => { ack(); const hint = liveHintSchema.safeParse(raw); if (!hint.success) { failure ??= 'hint_schema'; return; } if (hint.data.kind === 'conversation' && hint.data.conversationId === view.conversationId) void refresh(view); });
    socket.on('disconnect', () => { if (!stopping && !view.offline) failure ??= 'socket_disconnected'; });
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    const result = await socket.timeout(5000).emitWithAck('sync:subscribe', { conversationId: view.conversationId }) as { ok: boolean };
    if (!result.ok) throw new Error('subscription_rejected');
  }
  const close = async () => { stopping = true; for (const view of views) view.socket?.disconnect(); await Promise.allSettled(views.map(view => view.running)); await Promise.allSettled(actors.map(actor => actor.api.dispose())); };
  try {
    for (let n = 0; n < shape.chatUsers; n++) { check(); actors.push(await actor(request, `loadchat${n}`)); }
    for (let n = 0; n < shape.groups; n++) {
      const members = actors.slice(n * 4, n * 4 + 4), conversationId = await group(members);
      for (const member of members) {
        const response = await member.api.get(`/api/v1/sync/conversations/${conversationId}/snapshot`), snapshot = conversationSnapshotSchema.parse(await response.json());
        const view: View = { actor: member, conversationId, cursor: snapshot.watermark, applied: new Map(), socket: null, running: undefined, dirty: false, offline: false }; views.push(view); await connect(view);
      }
    }
    const outsider = await actor(request, 'loadoutsider'); actors.push(outsider);
    const denied = await outsider.api.get(`/api/v1/sync/conversations/${views[0]!.conversationId}/events?after=0`);
    if (denied.status() !== 403) throw new Error('outsider_replay_allowed');
  } catch (error) { await close(); throw error; }
  async function send(view: View, measured: boolean) {
    const n = index++, text = `Load ${n} `.padEnd(shape.payloadBytes, 'x'), command = { v: 1 as const, conversationId: view.conversationId, clientMessageId: randomUUID(), text, attachmentIds: [] as never[] }, started = performance.now();
    const result = acceptedReferenceSchema.parse(await post(view.actor, '/messages', command));
    if (measured) ackMs.push(performance.now() - started);
    sent.push({ actor: view.actor, conversationId: view.conversationId, command, result, started, measured });
    if (n % 10 === 9) { const retryAt = performance.now(), retry = acceptedReferenceSchema.parse(await post(view.actor, '/messages', command)); if (JSON.stringify(retry) !== JSON.stringify(result)) throw new Error('dedup_identity'); duplicateMs.push(performance.now() - retryAt); }
  }
  return {
    close,
    async window(ms: number, measured: boolean) {
      const start = performance.now(), count = Math.round(shape.rate * ms / 1000), pending = new Set<Promise<void>>();
      if (measured) measuredStart = start;
      try {
      for (let n = 0; n < count; n++) {
        const target = start + n * 1000 / shape.rate; await pause(Math.max(0, target - performance.now())); check(); offered++; if (measured) measuredOffered++;
        if (pending.size >= budget.maxInflight) { dropped++; failure = 'offered_slot_lost'; break; }
        if (measured) schedulingMs.push(Math.max(0, performance.now() - target));
        const task = send(views[index % views.length]!, measured).catch(() => { failure ??= 'send_or_dedup_failure'; }).finally(() => pending.delete(task)); pending.add(task);
      }
      await pause(Math.max(0, start + ms - performance.now()));
      } finally { await Promise.all(pending); }
      check();
      await until(() => sent.every(row => views.filter(view => view.conversationId === row.conversationId).every(view => view.applied.has(row.result.eventId))), check);
      if (measured) measuredEnd = performance.now();
      return { startMs: start, endMs: performance.now(), offered: count };
    },
    async verify() {
      check(); const source = sent[0]!;
      await post(source.actor, '/messages', { ...source.command, text: 'Changed reuse must conflict' }, 409);
      const view = views[1]!; view.offline = true; view.socket!.disconnect();
      const missed: Sent[] = [];
      for (let n = 0; n < 3; n++) { const before = sent.length; await send(views[0]!, false); missed.push(sent[before]!); }
      const replayStarted = performance.now(); await connect(view); view.offline = false; await refresh(view);
      await until(() => missed.every(row => view.applied.has(row.result.eventId)), check);
      const reconnectReplayMs = performance.now() - replayStarted;
      for (const reader of views) {
        await refresh(reader); check();
        const response = await reader.actor.api.get(`/api/v1/sync/conversations/${reader.conversationId}/snapshot`), snapshot = conversationSnapshotSchema.parse(await response.json());
        const expected = sent.filter(row => row.conversationId === reader.conversationId);
        if (snapshot.messages.length !== expected.length || new Set(snapshot.messages.map(row => row.id)).size !== expected.length) throw new Error('snapshot_count_or_duplicates');
        for (const row of expected) if (!snapshot.messages.some(message => message.id === row.result.message.messageId && message.clientMessageId === row.command.clientMessageId && message.text === row.command.text && message.creationSequence === row.result.message.creationSequence)) throw new Error('snapshot_content_or_identity');
      }
      return { reconnectReplayMs, offlineMessages: missed.length, outsiderDenied: true, changedReuseConflicted: true, snapshotsVerified: views.length };
    },
    summary() {
      const delivery = sent.filter(row => row.measured).flatMap(row => views.filter(view => view.conversationId === row.conversationId).flatMap(view => { const time = view.applied.get(row.result.eventId); return time === undefined ? [] : [Math.max(0, time - row.started)]; }));
      const measuredAccepted = sent.filter(row => row.measured).length, measuredIncludingDrainMs = measuredEnd ? measuredEnd - measuredStart : null;
      return { users: shape.chatUsers, sockets: views.length, groups: shape.groups, groupSize: 4, payloadBytes: shape.payloadBytes, configuredOfferedPerSecond: shape.rate, measuredIncludingDrainMs, achievedAcceptedPerSecondIncludingDrain: measuredIncludingDrainMs ? measuredAccepted * 1000 / measuredIncludingDrainMs : null, offered, measuredOffered, accepted: sent.length, measuredAccepted, dropped, failure, acceptanceMs: distribution(ackMs), referenceApplicationMs: distribution(delivery), scheduleLatenessMs: distribution(schedulingMs), explicitDuplicateAckMs: distribution(duplicateMs), deliveryBoundary: 'HTTP write start to authorized hint-triggered replay reference applied; excludes body/render/read latency' };
    },
  };
}
