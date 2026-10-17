import type { Long } from 'mongodb';
export type CallState = 'ringing' | 'active' | 'ending' | 'ended' | 'cancelled' | 'declined' | 'timed_out';
export interface CallRecord {
  _id: string; schemaVersion: 1; conversationId: string; creatorId: string; mode: 'voice' | 'video';
  state: CallState; open: boolean; endState: 'ended' | 'cancelled' | 'declined' | 'timed_out'; reason: string;
  generation: number; roomName: string; creationSeq: Long; createdAt: Date; updatedAt: Date; expiresAt: Date; ringUntil: Date;
  emptySince: Date | null; guardVersion: number; leaseOwner: string | null; leaseUntil: Date; availableAt: Date; failures: number;
}
export interface CallParticipant {
  _id: string; schemaVersion: 1; callId: string; userId: string; sessionId: string | null; authVersion: number;
  state: 'invited' | 'accepted' | 'declined' | 'left' | 'removed'; joined: boolean; roomGeneration: number; tokenAvailableAt: Date; createdAt: Date; updatedAt: Date;
}
export interface CallRoom {
  _id: string; schemaVersion: 1; callId: string; generation: number; state: 'pending' | 'ready' | 'deleting' | 'deleted'; createdAt: Date;
}
export interface CallCommand { _id: string; schemaVersion: 1; userId: string; commandId: string; digest: string; callId: string; createdAt: Date }
export interface CallWebhook { _id: string; schemaVersion: 1; roomName: string; kind: string; digest: string; state: 'pending' | 'done'; createdAt: Date }
export const callParticipantId = (callId: string, userId: string) => `${callId}:${userId}`;
export const mediaIdentity = (row: CallParticipant) => `${row.userId}:${row.sessionId}`;
