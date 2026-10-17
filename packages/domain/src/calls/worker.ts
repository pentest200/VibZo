import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import type { CallService } from './service.js';
import { callSchemaReady } from './migrations.js';
import { mediaIdentity } from './model.js';
import type { CallWebhook } from './model.js';

export class CallWorker {
  constructor(readonly service: CallService, private readonly afterProviderCreate?: () => Promise<void>) {}
  async webhookOnce() {
    const { db } = this.service; if (!await callSchemaReady(db)) return false;
    return this.service.run(async session => {
      const rows = db.collection<CallWebhook>('callWebhookInbox'), row = await rows.findOne({ state: 'pending' }, { session, sort: { createdAt: 1 } }); if (!row) return false;
      const room = await this.service.rooms().findOne({ _id: row.roomName }, { session });
      if (room) await this.service.calls().updateOne({ _id: room.callId, open: true }, { $set: { availableAt: new Date() }, $inc: { guardVersion: 1 } }, { session });
      // Webhook order is never authoritative: wake current provider/domain reconciliation.
      await rows.updateOne({ _id: row._id, state: 'pending' }, { $set: { state: 'done' } }, { session }); return true;
    });
  }
  async runOnce() {
    const service = this.service; if (!await callSchemaReady(service.db)) return false;
    const calls = service.calls(), owner = randomUUID();
    const claim = await calls.findOneAndUpdate({ open: true, $expr: { $and: [{ $lte: ['$availableAt', '$$NOW'] }, { $lte: ['$leaseUntil', '$$NOW'] }] } }, [
      { $set: { leaseOwner: owner, leaseUntil: { $dateAdd: { startDate: '$$NOW', unit: 'second', amount: 30 } } } }
    ], { sort: { availableAt: 1 }, returnDocument: 'after' }); if (!claim) return false;
    const live = { _id: claim._id, leaseOwner: owner, $expr: { $gt: ['$leaseUntil', '$$NOW'] } };
    const guarded = async (session: ClientSession) => {
      const row = await calls.findOneAndUpdate(live, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' });
      if (!row) throw new Error('Call reconciliation lease lost'); return row;
    };
    try {
      let call = await service.run(async session => {
        const call = await guarded(session);
        const conversation = await service.conversations().findOneAndUpdate({ _id: call.conversationId }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' });
        if (!conversation || conversation.state !== 'active' || !service.auth.config.CALLS_ENABLED) await service.ending(call, 'calls', 'Calling access ended.', 'ended', session);
        else if (call.state !== 'ending') {
          if (call.expiresAt <= new Date()) await service.ending(call, 'calls', 'Maximum call duration reached.', 'ended', session);
          else if (call.state === 'ringing' && call.ringUntil <= new Date()) await service.ending(call, 'calls', 'No answer.', 'timed_out', session);
          else {
            const parts = await service.participants().find({ callId: call._id, state: 'accepted' }, { session }).sort({ userId: 1 }).limit(12).toArray();
            let removed = false;
            for (const part of parts) if (!await service.validParticipant(call, part, session)) {
              await service.participants().updateOne({ _id: part._id }, { $set: { state: 'removed', joined: false, updatedAt: new Date() } }, { session }); removed = true;
            }
            const current = await service.participants().find({ callId: call._id, state: 'accepted' }, { session }).sort({ userId: 1 }).limit(12).toArray();
            let blocked = false;
            for (let i = 0; i < current.length; i++) for (const peer of current.slice(i + 1)) if ((await service.guardPair(current[i]!.userId, peer.userId, session, true)).blockedBy.length) blocked = true;
            // Also honor a block involving the inviter before an invited user accepts.
            if (conversation.directPair) { const [a, b] = conversation.directPair.split(':'); if (a && b && (await service.guardPair(a, b, session, true)).blockedBy.length) blocked = true; }
            if (blocked || !current.length) await service.ending(call, 'calls', blocked ? 'Contact access changed.' : 'No eligible participants.', 'ended', session);
            else if (removed && conversation.kind === 'direct') await service.ending(call, 'calls', 'Participant access ended.', 'ended', session);
            else if (removed) await service.rotate(call, session);
          }
        }
        return (await calls.findOne({ _id: call._id }, { session }))!;
      });
      // Close every older incarnation before admitting anyone to the next one.
      const deleting = await service.rooms().find({ callId: call._id, state: 'deleting' }).sort({ generation: 1 }).limit(21).toArray();
      for (const room of deleting) {
        await service.provider.removeRoom(room._id);
        await service.run(async session => { await guarded(session); await service.rooms().updateOne({ _id: room._id, state: 'deleting' }, { $set: { state: 'deleted' } }, { session }); });
      }
      call = (await calls.findOne(live))!; if (!call) throw new Error('Call lease lost');
      if (call.state === 'ending') {
        await service.run(async session => {
          const call = await guarded(session);
          if (await service.rooms().findOne({ callId: call._id, state: { $ne: 'deleted' } }, { session })) return;
          await calls.updateOne(live, { $set: { state: call.endState, open: false, updatedAt: new Date() } }, { session });
          await service.participants().updateMany({ callId: call._id, state: 'accepted' }, { $set: { state: 'left', joined: false, updatedAt: new Date() } }, { session });
          await service.event(call.conversationId, 'calls', 'call.ended', { callId: call._id }, session);
        });
      } else {
        const room = await service.rooms().findOne({ _id: call.roomName });
        if (room?.state === 'pending') {
          await service.provider.create(room._id); await this.afterProviderCreate?.();
          await service.run(async session => {
            const fresh = await guarded(session);
            if (fresh.roomName !== room._id || fresh.state === 'ending') return;
            if (await service.rooms().findOne({ callId: call._id, state: 'deleting' }, { session })) return;
            await service.rooms().updateOne({ _id: room._id, state: 'pending' }, { $set: { state: 'ready' } }, { session });
            await service.event(call.conversationId, 'calls', 'call.updated', { callId: call._id }, session);
          });
        } else if (room?.state === 'ready') {
          const observed = await service.provider.participants(room._id);
          await service.run(async session => {
            const fresh = await guarded(session); if (fresh.roomName !== room._id || fresh.state === 'ending') return;
            const parts = await service.participants().find({ callId: call._id, state: 'accepted' }, { session }).limit(12).toArray();
            if (observed === null || observed.some(p => !parts.some(part => mediaIdentity(part) === p.identity))) { await service.rotate(fresh, session); return; }
            let changed = false;
            for (const part of parts) {
              const joined = observed.some(p => p.identity === mediaIdentity(part));
              if (joined !== part.joined) { await service.participants().updateOne({ _id: part._id }, { $set: { joined, updatedAt: new Date() } }, { session }); changed = true; }
            }
            if (!observed.length && fresh.emptySince && fresh.emptySince.getTime() < Date.now() - 30000) await service.ending(fresh, 'calls', 'Call empty after reconnect grace.', 'ended', session);
            else {
              await calls.updateOne(live, { $set: { emptySince: observed.length ? null : fresh.emptySince ?? new Date(), reason: '' } }, { session });
              if (changed) await service.event(call.conversationId, 'calls', 'call.updated', { callId: call._id }, session);
            }
          });
        }
      }
      await calls.updateOne(live, { $set: { failures: 0, leaseOwner: null, leaseUntil: new Date(0), availableAt: new Date(Date.now() + 1000) } });
    } catch {
      // Cleanup never silently expires or becomes abandoned after an arbitrary retry count.
      await calls.updateOne(live, { $set: { leaseOwner: null, leaseUntil: new Date(0), availableAt: new Date(Date.now() + Math.min(30000, 1000 * 2 ** Math.min(claim.failures, 5)) + Math.floor(Math.random() * 250)) }, $inc: { failures: 1 } }).catch(() => {});
    } return true;
  }
}
export async function callMetrics(service: CallService) {
  const active = await service.calls().countDocuments({ open: true }), delayed = await service.calls().countDocuments({ open: true, failures: { $gt: 0 } });
  const closing = await service.rooms().countDocuments({ state: 'deleting' });
  return `chat_calls_open ${active}\nchat_calls_reconciliation_delayed ${delayed}\nchat_call_rooms_pending_delete ${closing}\n`;
}
