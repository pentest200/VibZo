import { randomUUID } from 'node:crypto';
import { sendMessageSchema } from '@chat/contracts';
import type { AcceptedMessage } from '@chat/contracts';
import { ConversationService } from '../conversations/service.js';
import { conflict, denied } from '../conversations/store.js';
import type { MessageRecord, VisibilityRecord } from '../conversations/model.js';
import { DomainError, unavailable } from '../auth/errors.js';
import { tokenHash } from '../auth/crypto.js';
import { longToSequence } from '../sequence.js';
import { messagingSchemaReady } from './migrations.js';
import type { MessageCommand } from './model.js';
const accepted = (command: MessageCommand): AcceptedMessage => ({ status: 'accepted', eventId: command.eventId,
  message: { messageId: command.messageId, senderId: command.senderId, clientMessageId: command.clientMessageId, creationSequence: longToSequence(command.creationSeq) } });
export class MessageService extends ConversationService {
  async send(token: string | undefined, raw: unknown): Promise<AcceptedMessage> {
    const parsed = sendMessageSchema.safeParse(raw);
    if (!parsed.success) throw new DomainError('INVALID_INPUT', 'Check the message fields and length.', 400);
    const input = parsed.data, text = input.text.replace(/\r\n?/g, '\n').normalize('NFC');
    if (Array.from(text).length > this.auth.config.MAX_MESSAGE_CODEPOINTS) throw new DomainError('INVALID_INPUT', 'The message exceeds the configured length.', 400);
    if (input.attachmentIds.length) throw new DomainError('INVALID_INPUT', 'Attachments are not available yet.', 400);
    if (!await messagingSchemaReady(this.db)) throw unavailable();
    const messageId = randomUUID(), eventId = randomUUID(), now = new Date();
    const digest = tokenHash(JSON.stringify({ v: 1, conversationId: input.conversationId, text, replyToId: input.replyToId ?? null, attachmentIds: input.attachmentIds }));
    return this.authorizedOperation(token, input.conversationId, async ({ principal, session }) => {
      const senderId = principal.user._id, key = { conversationId: input.conversationId, senderId, clientMessageId: input.clientMessageId };
      const commands = this.db.collection<MessageCommand>('messageCommands'), previous = await commands.findOne(key, { session });
      if (previous) { if (previous.digest !== digest) throw conflict('This message ID was already used with different content.'); return accepted(previous); }
      if (input.replyToId) {
        const reply = await this.db.collection<MessageRecord>('messages').findOne({ _id: input.replyToId, conversationId: input.conversationId, deletedAt: null }, { session });
        if (!reply) throw denied();
        const visible = await this.db.collection<VisibilityRecord>('visibilityIntervals').findOne({ conversationId: input.conversationId, userId: senderId, startSeq: { $lte: reply.creationSeq }, $or: [{ endSeq: null }, { endSeq: { $gt: reply.creationSeq } }] }, { session });
        if (!visible) throw denied();
      }
      const creationSeq = await this.event(input.conversationId, senderId, 'message.created', { messageId }, session, [], eventId);
      await this.db.collection<MessageRecord>('messages').insertOne({ _id: messageId, schemaVersion: 1, ...key, originalDigest: digest, creationSeq, text, replyToId: input.replyToId ?? null, deletedAt: null, createdAt: now }, { session });
      const command: MessageCommand = { _id: `${input.conversationId}:${senderId}:${input.clientMessageId}`, schemaVersion: 1, ...key, digest, messageId, eventId, creationSeq, createdAt: now };
      await commands.insertOne(command, { session }); return accepted(command);
    });
  }
}
