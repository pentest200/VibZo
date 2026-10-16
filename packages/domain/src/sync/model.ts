import type { Long } from 'mongodb';
import type { ConversationSnapshot, MessageMutation } from '@chat/contracts';
export interface Reaction { _id: string; schemaVersion: 1; conversationId: string; messageId: string; userId: string; reaction: string; createdAt: Date }
export interface Receipt { _id: string; schemaVersion: 1; conversationId: string; userId: string; delivered: Long; deliveredFrom: Long; read: Long; createdAt: Date }
export interface MutationCommand { _id: string; schemaVersion: 1; userId: string; commandId: string; digest: string; sequence: Long; createdAt: Date }
export interface ReplayFloor { _id: string; schemaVersion: 1; floor: Long; createdAt: Date }
export interface SnapshotRecord { _id: string; schemaVersion: 1; userId: string; kind: 'inbox' | 'conversation'; conversationId: string | null; watermark: string; payload: ConversationSnapshot | unknown[]; expiresAt: Date; createdAt: Date }
export type MutationInput = MessageMutation;
