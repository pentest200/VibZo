import type { Long } from 'mongodb';
import type { PublicUser } from '@chat/contracts';
import type { UserRecord } from '../auth/model.js';
export interface ConversationRecord {
  _id: string; schemaVersion: 1; kind: 'direct' | 'group'; title: string; directPair: string | null;
  state: 'active' | 'archived'; nextEventSeq: Long; guardVersion: number; createdAt: Date; updatedAt: Date;
}
export interface MembershipRecord {
  _id: string; schemaVersion: 1; conversationId: string; userId: string; role: 'owner' | 'admin' | 'member';
  state: 'active' | 'invited' | 'removed' | 'left'; guardVersion: number; inviterId: string | null;
  invitationExpiresAt: Date | null; createdAt: Date; updatedAt: Date;
}
export interface VisibilityRecord { _id: string; schemaVersion: 1; conversationId: string; userId: string; startSeq: Long; endSeq: Long | null; createdAt: Date }
export interface PairRecord { _id: string; schemaVersion: 1; userIds: string[]; blockedBy: string[]; guardVersion: number; createdAt: Date }
export interface BlockRecord { _id: string; schemaVersion: 1; blockerId: string; blockedId: string; createdAt: Date }
export interface InboxCounter { _id: string; schemaVersion: 1; sequence: Long; guardVersion: number; createdAt: Date }
export interface InboxEvent { _id: string; schemaVersion: 1; userId: string; sequence: Long; conversationId: string | null; kind: 'conversation.changed' | 'blocks.changed'; createdAt: Date }
export interface ControlEvent { _id: string; schemaVersion: 1; conversationId: string; sequence: Long; actorId: string; kind: string; payload: Record<string,string>; createdAt: Date }
export interface OutboxRecord { _id: string; schemaVersion: 1; eventId: string; topic: string; status: 'pending' | 'claimed' | 'published'; availableAt: Date; leaseUntil: Date; leaseOwner: string | null; attempts: number; publishedAt: Date | null; createdAt: Date }
export interface MessageRecord { _id: string; schemaVersion: 1; conversationId: string; senderId: string; clientMessageId: string; originalDigest: string; creationSeq: Long; text: string; replyToId?: string | null; deletedAt: Date | null; createdAt: Date }
export interface CreateCommand { _id: string; schemaVersion: 1; userId: string; clientCommandId: string; digest: string; conversationId: string; createdAt: Date }
export const pairId = (a: string, b: string) => [a,b].sort().join(':');
export const membershipId = (conversationId: string, userId: string) => `${conversationId}:${userId}`;
export function publicUser(user: UserRecord): PublicUser { return { id: user._id, username: user.usernameCanonical, displayName: user.displayName, avatarId: user.avatarId }; }
