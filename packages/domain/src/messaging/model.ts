import type { Long } from 'mongodb';
export interface Admission { _id: string; schemaVersion: 1; guardVersion: number; createdAt: Date }
export interface MessageCommand { _id: string; schemaVersion: 1; conversationId: string; senderId: string; clientMessageId: string; digest: string; messageId: string; eventId: string; creationSeq: Long; createdAt: Date }
export type Subscription = 'fanout' | 'notification';
export interface Effect { _id: string; schemaVersion: 1; eventId: string; subscription: Subscription; createdAt: Date }
export interface ProjectionJob { _id: string; schemaVersion: 1; eventId: string; conversationId: string; sequence: Long; state: 'pending' | 'claimed' | 'published'; leaseOwner?: string | null; leaseUntil?: Date; publishedAt?: Date | null; createdAt: Date }
