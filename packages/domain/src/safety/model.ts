export interface NotificationPreference { _id: string; schemaVersion: 1; enabled: boolean; createdAt: Date }
export interface DeviceRecord {
  _id: string; schemaVersion: 1; userId: string; sessionId: string; endpointHash: string;
  encrypted: string; expiresAt: Date; createdAt: Date;
}
export interface PushJob {
  _id: string; schemaVersion: 1; userId: string; subscriptionId: string; eventId: string; conversationId: string;
  state: 'pending' | 'claimed' | 'sent' | 'skipped' | 'failed'; attempts: number; leaseOwner: string | null;
  leaseUntil: Date; availableAt: Date; expiresAt: Date; outcome: string; createdAt: Date;
}
export interface ReportRecord {
  _id: string; schemaVersion: 1; reporterId: string; commandId: string; digest: string;
  conversationId: string; messageId: string | null; reason: 'spam' | 'harassment' | 'unsafe' | 'other';
  state: 'open' | 'dismissed' | 'removed'; createdAt: Date;
}
export interface DeletionJob {
  _id: string; schemaVersion: 1; state: 'pending' | 'claimed' | 'done' | 'failed';
  attempts: number; leaseOwner: string | null; leaseUntil: Date; availableAt: Date; outcome: string; createdAt: Date;
}
