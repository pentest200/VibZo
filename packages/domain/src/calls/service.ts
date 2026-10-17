import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import { callActionSchema, startCallSchema } from '@chat/contracts';
import type { CallView } from '@chat/contracts';
import { DomainError, unavailable } from '../auth/errors.js';
import { tokenHash } from '../auth/crypto.js';
import type { UserRecord, SessionRecord } from '../auth/model.js';
import { ConversationStore, conflict, denied } from '../conversations/store.js';
import type { ConversationContext } from '../conversations/store.js';
import type { VisibilityRecord } from '../conversations/model.js';
import type { Admission } from '../messaging/model.js';
import { callSchemaReady } from './migrations.js';
import { LiveKitProvider } from './provider.js';
import type { CallProvider } from './provider.js';
import { callParticipantId, mediaIdentity } from './model.js';
import type { CallRecord, CallRoom, CallParticipant, CallCommand, CallWebhook } from './model.js';

export class CallService extends ConversationStore {
  readonly provider: CallProvider;
  constructor(auth: ConversationStore['auth'], provider?: CallProvider) { super(auth); this.provider = provider ?? new LiveKitProvider(auth.config); }
  calls() { return this.db.collection<CallRecord>('calls'); }
  participants() { return this.db.collection<CallParticipant>('callParticipants'); }
  rooms() { return this.db.collection<CallRoom>('callRooms'); }
  async ready(enabled = true) { if (!await callSchemaReady(this.db) || enabled && !this.auth.config.CALLS_ENABLED) throw unavailable(); }
  async status(token: string | undefined) {
    const principal = await this.auth.authenticate(token);
    if (!principal.user.verifiedAt) throw denied();
    const enabled = this.auth.config.CALLS_ENABLED && await callSchemaReady(this.db);
    return { enabled, available: enabled && await this.provider.health() };
  }
  private async visible(call: CallRecord, userId: string, session: ClientSession) {
    return !!await this.db.collection<VisibilityRecord>('visibilityIntervals').findOne({ conversationId: call.conversationId, userId, startSeq: { $lte: call.creationSeq }, $or: [{ endSeq: null }, { endSeq: { $gt: call.creationSeq } }] }, { session });
  }
  async view(call: CallRecord, ctx: ConversationContext): Promise<CallView> {
    if (!await this.visible(call, ctx.principal.user._id, ctx.session)) throw denied();
    const rows = await this.participants().find({ callId: call._id }, { session: ctx.session }).sort({ createdAt: 1, userId: 1 }).limit(50).toArray();
    const room = await this.rooms().findOne({ _id: call.roomName, state: 'ready' }, { session: ctx.session });
    const manager = ctx.conversation.kind === 'group' && ctx.membership.role !== 'member';
    const users = await this.db.collection<UserRecord>('users').find({ _id: { $in: rows.map(p => p.userId) } }, { session: ctx.session, projection: { displayName: 1 } }).toArray();
    const names = new Map(users.map(u => [u._id, u.displayName]));
    const other = ctx.conversation.directPair?.split(':').find(id => id !== ctx.principal.user._id);
    return { id: call._id, conversationId: call.conversationId, creatorId: call.creatorId, title: other ? names.get(other) ?? 'Unavailable account' : ctx.conversation.title, mode: call.mode, state: call.state, generation: call.generation,
      ready: !!room && call.open && call.state !== 'ending', reason: call.reason, createdAt: call.createdAt.toISOString(), expiresAt: call.expiresAt.toISOString(), ringUntil: call.ringUntil.toISOString(),
      participants: rows.map(row => ({ userId: row.userId, displayName: names.get(row.userId) ?? 'Former member', state: row.state, joined: row.joined, currentDevice: row.sessionId === ctx.principal.session._id })),
      canEnd: call.creatorId === ctx.principal.user._id || manager, canRemove: manager };
  }
  async get(token: string | undefined, id: string) {
    await this.ready(false); return this.run(async session => {
      const call = await this.calls().findOne({ _id: id }, { session }); if (!call) throw denied();
      return this.view(call, await this.authorize(token, call.conversationId, session));
    });
  }
  async list(token: string | undefined, conversationId: string) {
    await this.ready(false); return this.run(async session => {
      const ctx = await this.authorize(token, conversationId, session), rows = await this.calls().find({ conversationId }, { session }).sort({ createdAt: -1, _id: -1 }).limit(20).toArray();
      const views: CallView[] = []; for (const row of rows) if (await this.visible(row, ctx.principal.user._id, session)) views.push(await this.view(row, ctx)); return views;
    });
  }
  async invitations(token: string | undefined) {
    await this.ready(false); const principal = await this.auth.authenticate(token);
    const parts = await this.participants().find({ userId: principal.user._id, state: { $in: ['invited', 'accepted'] } }).sort({ createdAt: -1 }).limit(20).toArray();
    const calls: CallView[] = [];
    for (const part of parts) {
      const row = await this.calls().findOne({ _id: part.callId, open: true }); if (!row) continue;
      try { calls.push(await this.get(token, row._id)); } catch (e) { if (!(e instanceof DomainError) || e.status !== 403) throw e; }
    } return calls;
  }
  private commands() { return this.db.collection<CallCommand>('callCommands'); }
  private async previous(userId: string, commandId: string, digest: string, session: ClientSession) {
    const prior = await this.commands().findOne({ userId, commandId }, { session });
    if (prior && prior.digest !== digest) throw conflict('This call action ID was used for different input.'); return prior;
  }
  private async command(userId: string, commandId: string, digest: string, callId: string, session: ClientSession) {
    await this.commands().insertOne({ _id: `${userId}:${commandId}`, schemaVersion: 1, userId, commandId, digest, callId, createdAt: new Date() }, { session });
  }
  roomName(id: string, generation: number) { return `${this.auth.config.MONGODB_DATABASE}_call_${id}_${generation}_${randomUUID()}`; }
  async start(token: string | undefined, raw: unknown) {
    await this.ready(); const parsed = startCallSchema.safeParse(raw); if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Check the call fields.', 400);
    const input = parsed.data, digest = tokenHash(JSON.stringify(input)), id = randomUUID();
    // Media outage never produces a fictitious ready room or globally disables chat.
    if (!await this.provider.health()) throw unavailable();
    return this.run(async session => {
      const ctx = await this.authorize(token, input.conversationId, session, 'write'), userId = ctx.principal.user._id;
      const prior = await this.previous(userId, input.commandId, digest, session); if (prior) return { id: prior.callId };
      if (await this.participants().findOne({ userId, state: 'accepted' }, { session })) throw conflict('Leave your current call before starting another.');
      await this.db.collection<Admission>('outboxAdmission').updateOne({ _id: 'calls' }, { $inc: { guardVersion: 1 } }, { session });
      if (await this.calls().countDocuments({ open: true }, { session, limit: this.auth.config.MAX_OPEN_CALLS }) >= this.auth.config.MAX_OPEN_CALLS) throw unavailable();
      if (await this.calls().findOne({ conversationId: input.conversationId, open: true }, { session })) throw conflict('A call is already open in this conversation.');
      const members = await this.members().find({ conversationId: input.conversationId, state: 'active' }, { session }).sort({ userId: 1 }).limit(50).toArray(), eligible: string[] = [];
      for (const member of members) {
        const user = await this.db.collection<UserRecord>('users').findOneAndUpdate({ _id: member.userId, deletionState: 'active', verifiedAt: { $ne: null } }, { $inc: { guardVersion: 1 } }, { session });
        if (!user) continue;
        if (member.userId !== userId && (await this.guardPair(userId, member.userId, session, true)).blockedBy.length) continue;
        eligible.push(member.userId);
      }
      if (ctx.conversation.kind === 'direct' && eligible.length !== 2) throw denied();
      const now = new Date(), roomName = this.roomName(id, 1), creationSeq = await this.event(input.conversationId, userId, 'call.created', { callId: id }, session);
      await this.calls().insertOne({ _id: id, schemaVersion: 1, conversationId: input.conversationId, creatorId: userId, mode: input.mode, state: 'ringing', open: true, endState: 'ended', reason: '', generation: 1, roomName, creationSeq,
        createdAt: now, updatedAt: now, expiresAt: new Date(now.getTime() + this.auth.config.MAX_CALL_DURATION_MINUTES * 60000), ringUntil: new Date(now.getTime() + 45000), emptySince: null, guardVersion: 0, leaseOwner: null, leaseUntil: new Date(0), availableAt: now, failures: 0 }, { session });
      for (const memberId of eligible) await this.participants().insertOne({ _id: callParticipantId(id, memberId), schemaVersion: 1, callId: id, userId: memberId, sessionId: memberId === userId ? ctx.principal.session._id : null,
        authVersion: memberId === userId ? ctx.principal.user.authVersion : 0, state: memberId === userId ? 'accepted' : 'invited', joined: false, roomGeneration: 0, tokenAvailableAt: new Date(0), createdAt: now, updatedAt: now }, { session });
      await this.rooms().insertOne({ _id: roomName, schemaVersion: 1, callId: id, generation: 1, state: 'pending', createdAt: now }, { session });
      await this.command(userId, input.commandId, digest, id, session); return { id };
    });
  }
  async ending(call: CallRecord, actor: string, reason: string, endState: CallRecord['endState'], session: ClientSession) {
    if (!call.open || call.state === 'ending') return;
    await this.calls().updateOne({ _id: call._id }, { $set: { state: 'ending', endState, reason, updatedAt: new Date(), availableAt: new Date() }, $inc: { guardVersion: 1 } }, { session });
    await this.rooms().updateMany({ callId: call._id, state: { $ne: 'deleted' } }, { $set: { state: 'deleting' } }, { session });
    await this.event(call.conversationId, actor, 'call.updated', { callId: call._id }, session);
  }
  async rotate(call: CallRecord, session: ClientSession) {
    if (call.generation >= this.auth.config.MAX_CALL_ROTATIONS) { await this.ending(call, 'calls', 'Repeated connection changes. Start another call.', 'ended', session); return; }
    const generation = call.generation + 1, roomName = this.roomName(call._id, generation);
    await this.rooms().updateMany({ callId: call._id, state: { $ne: 'deleted' } }, { $set: { state: 'deleting' } }, { session });
    await this.rooms().insertOne({ _id: roomName, schemaVersion: 1, callId: call._id, generation, state: 'pending', createdAt: new Date() }, { session });
    await this.participants().updateMany({ callId: call._id, state: 'accepted' }, { $set: { joined: false, tokenAvailableAt: new Date(0), updatedAt: new Date() } }, { session });
    await this.calls().updateOne({ _id: call._id }, { $set: { generation, roomName, emptySince: null, availableAt: new Date(), updatedAt: new Date(), reason: 'Connection updated. Rejoin the call.' }, $inc: { guardVersion: 1 } }, { session });
    await this.event(call.conversationId, 'calls', 'call.updated', { callId: call._id }, session);
  }
  async action(token: string | undefined, id: string, raw: unknown) {
    await this.ready(false); const parsed = callActionSchema.safeParse(raw); if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Check the call action.', 400);
    const input = parsed.data, digest = tokenHash(JSON.stringify({ id, ...input }));
    return this.run(async session => {
      const call = await this.calls().findOneAndUpdate({ _id: id }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' }); if (!call) throw denied();
      const ctx = await this.authorize(token, call.conversationId, session, input.action === 'accept' ? 'write' : 'history'), userId = ctx.principal.user._id;
      if (!await this.visible(call, userId, session)) throw denied();
      if (await this.previous(userId, input.commandId, digest, session)) return { id };
      if (!call.open || call.state === 'ending' || call.expiresAt <= new Date() || call.state === 'ringing' && call.ringUntil <= new Date()) throw conflict('This call has ended or is closing.');
      const participant = await this.participants().findOne({ _id: callParticipantId(id, userId) }, { session });
      const manager = ctx.conversation.kind === 'group' && ctx.membership.role !== 'member';
      if (input.action === 'accept') {
        if (!this.auth.config.CALLS_ENABLED || !participant || !['invited', 'accepted'].includes(participant.state)) throw denied();
        if (participant.state === 'accepted' && participant.sessionId !== ctx.principal.session._id) throw conflict('This call was accepted on another device.');
        if (participant.state !== 'accepted') {
          if (await this.participants().findOne({ userId, state: 'accepted' }, { session })) throw conflict('Leave your current call before accepting another.');
          const accepted = await this.participants().find({ callId: id, state: 'accepted' }, { session }).limit(12).toArray();
          if (accepted.length >= this.auth.config.MAX_CALL_PARTICIPANTS) throw conflict('The call participant limit has been reached.');
          for (const peer of accepted) await this.guardPair(userId, peer.userId, session);
          await this.participants().updateOne({ _id: participant._id }, { $set: { state: 'accepted', sessionId: ctx.principal.session._id, authVersion: ctx.principal.user.authVersion, updatedAt: new Date() } }, { session });
          await this.calls().updateOne({ _id: id }, { $set: { state: 'active', updatedAt: new Date(), availableAt: new Date() } }, { session });
          await this.event(call.conversationId, userId, 'call.updated', { callId: id }, session);
        }
      } else if (input.action === 'cancel' || input.action === 'end') {
        if (call.creatorId !== userId && !manager || input.action === 'cancel' && call.state !== 'ringing') throw denied();
        await this.ending(call, userId, input.action === 'cancel' ? 'Call cancelled.' : 'Call ended.', input.action === 'cancel' ? 'cancelled' : 'ended', session);
      } else if (input.action === 'remove') {
        if (!manager || !input.targetUserId || input.targetUserId === userId) throw denied();
        const member = await this.members().findOne({ conversationId: call.conversationId, userId: input.targetUserId, state: 'active' }, { session });
        if (!member || member.role === 'owner' || ctx.membership.role === 'admin' && member.role === 'admin') throw denied();
        const changed = await this.participants().updateOne({ _id: callParticipantId(id, input.targetUserId), state: { $in: ['invited', 'accepted'] } }, { $set: { state: 'removed', joined: false, updatedAt: new Date() } }, { session });
        if (!changed.matchedCount) throw denied(); await this.rotate(call, session);
      } else {
        if (!participant || input.action === 'decline' && participant.state !== 'invited' || input.action === 'leave' && (participant.state !== 'accepted' || participant.sessionId !== ctx.principal.session._id)) throw denied();
        await this.participants().updateOne({ _id: participant._id }, { $set: { state: input.action === 'decline' ? 'declined' : 'left', joined: false, updatedAt: new Date() } }, { session });
        if (ctx.conversation.kind === 'direct' || input.action === 'leave' && await this.participants().countDocuments({ callId: id, state: 'accepted' }, { session }) === 0) await this.ending(call, userId, input.action === 'decline' ? 'Call declined.' : 'Everyone left.', input.action === 'decline' ? 'declined' : 'ended', session);
        else if (input.action === 'leave') await this.rotate(call, session);
        else await this.event(call.conversationId, userId, 'call.updated', { callId: id }, session);
      }
      await this.command(userId, input.commandId, digest, id, session); return { id };
    });
  }
  async join(token: string | undefined, id: string) {
    await this.ready(); const result = await this.run(async session => {
      const call = await this.calls().findOneAndUpdate({ _id: id, open: true, state: { $in: ['ringing', 'active'] }, expiresAt: { $gt: new Date() } }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' }); if (!call) throw denied();
      const ctx = await this.authorize(token, call.conversationId, session, 'write');
      const part = await this.participants().findOne({ _id: callParticipantId(id, ctx.principal.user._id), state: 'accepted', sessionId: ctx.principal.session._id, authVersion: ctx.principal.user.authVersion }, { session }); if (!part) throw denied();
      const peers = await this.participants().find({ callId: id, state: 'accepted', userId: { $ne: part.userId } }, { session }).limit(12).toArray();
      for (const peer of peers) { if (!await this.validParticipant(call, peer, session)) throw unavailable(); await this.guardPair(part.userId, peer.userId, session); }
      if (!await this.rooms().findOne({ _id: call.roomName, state: 'ready' }, { session }) || await this.rooms().findOne({ callId: id, state: 'deleting' }, { session })) throw unavailable();
      if (part.tokenAvailableAt > new Date()) throw new DomainError('RATE_LIMITED', 'Wait a moment before rejoining.', 429, true);
      await this.participants().updateOne({ _id: part._id }, { $set: { tokenAvailableAt: new Date(Date.now() + 5000), roomGeneration: call.generation } }, { session });
      const ttl = Math.min(this.auth.config.CALL_TOKEN_SECONDS, Math.floor((call.expiresAt.getTime() - Date.now()) / 1000), Math.floor((ctx.principal.session.expiresAt.getTime() - Date.now()) / 1000));
      if (ttl < 1 || call.state === 'ringing' && call.ringUntil <= new Date()) throw denied();
      return { roomName: call.roomName, identity: mediaIdentity(part), mode: call.mode, generation: call.generation, ttl };
    });
    return { token: await this.provider.token(result.roomName, result.identity, result.mode, result.ttl), url: this.auth.config.LIVEKIT_URL, identity: result.identity, generation: result.generation, expiresAt: new Date(Date.now() + result.ttl * 1000).toISOString() };
  }
  async validParticipant(call: CallRecord, part: CallParticipant, session: ClientSession) {
    const user = await this.db.collection<UserRecord>('users').findOneAndUpdate({ _id: part.userId, deletionState: 'active', authVersion: part.authVersion, verifiedAt: { $ne: null } }, { $inc: { guardVersion: 1 } }, { session }); if (!user) return false;
    if (!await this.members().findOneAndUpdate({ conversationId: call.conversationId, userId: part.userId, state: 'active' }, { $inc: { guardVersion: 1 } }, { session })) return false;
    return !!await this.db.collection<SessionRecord>('sessions').findOneAndUpdate({ _id: part.sessionId!, userId: part.userId, authVersion: part.authVersion, revokedAt: null, expiresAt: { $gt: new Date() } }, { $inc: { guardVersion: 1 } }, { session });
  }
  async webhook(body: Buffer, authorization: string | undefined) {
    await this.ready(false); if (body.length > 65536) throw new DomainError('INVALID_INPUT', 'Webhook too large.', 413);
    // SDK takes a string. Reject lossy UTF-8 decoding so altered raw bytes cannot
    // normalize to the same signed string (for example an invalid byte vs U+FFFD).
    const decoded = body.toString('utf8'); if (!Buffer.from(decoded, 'utf8').equals(body)) throw denied();
    let event; try { event = await new LiveKitProvider(this.auth.config).receiver.receive(decoded, authorization); } catch { throw denied(); }
    if (!event.id || event.id.length > 128) throw new DomainError('INVALID_INPUT', 'Invalid webhook reference.', 400);
    const roomName = event.room?.name ?? '', digest = tokenHash(decoded);
    return this.run(async session => {
      const rows = this.db.collection<CallWebhook>('callWebhookInbox'), previous = await rows.findOne({ _id: event.id }, { session });
      if (previous) { if (previous.digest !== digest) throw conflict('Webhook reference conflict.'); return { accepted: true }; }
      if (!await this.rooms().findOne({ _id: roomName }, { session })) return { accepted: true };
      await this.db.collection<Admission>('outboxAdmission').updateOne({ _id: 'calls' }, { $inc: { guardVersion: 1 } }, { session });
      if (await rows.countDocuments({ state: 'pending' }, { session, limit: 10000 }) >= 10000) throw unavailable();
      await rows.insertOne({ _id: event.id, schemaVersion: 1, roomName, kind: event.event, digest, state: 'pending', createdAt: new Date() }, { session }); return { accepted: true };
    });
  }
}
