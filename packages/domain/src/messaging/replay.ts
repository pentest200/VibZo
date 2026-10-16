import { randomUUID } from 'node:crypto';
import { brokerEventSchema } from '@chat/contracts';
import { requireModerator } from '../auth/service.js';
import { DomainError } from '../auth/errors.js';
import type { ControlEvent } from '../conversations/model.js';
import type { ConversationService } from '../conversations/service.js';
import { eventReference, InvalidBrokerEvent } from './delivery.js';
import type { BrokerTransport } from './broker.js';
import type { Subscription } from './model.js';
export async function replayDeadLetters(service: ConversationService, broker: BrokerTransport, token: string | undefined, subscription: Subscription, limit: number) {
  if (!['fanout', 'notification'].includes(subscription) || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new DomainError('INVALID_INPUT', 'Replay requires a subscription and limit of 1–20.', 400);
  // Check privilege even for an empty queue; repeat under transactional guard for each actual handoff.
  await service.run(async session => { requireModerator(await service.actor(token, session)); });
  const channel = await broker.channel(); let replayed = 0;
  try {
    while (replayed < limit) {
      const message = await channel.get(`${broker.queue(subscription)}.dead`, { noAck: false }); if (!message) break;
      let parsed: ReturnType<typeof brokerEventSchema.parse>;
      try { parsed = brokerEventSchema.parse(JSON.parse(message.content.toString('utf8'))); } catch { throw new InvalidBrokerEvent(); }
      const auditId = randomUUID();
      await service.run(async session => {
        const principal = await service.actor(token, session); requireModerator(principal);
        const event = await service.db.collection<ControlEvent>('conversationEvents').findOne({ _id: parsed.eventId }, { session });
        if (!event || JSON.stringify(eventReference(event)) !== JSON.stringify(parsed) || event.createdAt.getTime() < Date.now() - service.auth.config.EFFECT_RETENTION_DAYS * 86400000) throw new InvalidBrokerEvent();
        await service.db.collection<{ _id: string; schemaVersion: number; actorId: string; action: string; targetId: string; createdAt: Date }>('auditEvents').insertOne({ _id: auditId, schemaVersion: 1, actorId: principal.user._id, action: `dlq.replay_requested.${subscription}`, targetId: event._id, createdAt: new Date() }, { session });
      });
      await broker.publish(`${broker.prefix}.resume`, subscription, message.content, { messageId: parsed.eventId, headers: { 'x-app-attempt': 0 } });
      channel.ack(message); replayed++;
    }
    return replayed;
  } finally { await channel.close().catch(() => {}); }
}
