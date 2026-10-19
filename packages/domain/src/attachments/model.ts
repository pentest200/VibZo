import type { AttachmentReference } from '@chat/contracts';
export type AttachmentKind = AttachmentReference['kind'];
export interface AttachmentRecord {
  _id: string; schemaVersion: 1; ownerId: string; conversationId: string | null; purpose?: 'avatar'; avatarActive?: boolean; name: string; kind: AttachmentKind; size: number; sha256: string;
  state: 'pending' | 'uploaded' | 'processing' | 'ready' | 'rejected' | 'deleting' | 'deleted';
  sourceKey: string; approvedKey: string | null; approvedSize: number; approvedType: string | null; approvedSha256: string | null; sourceCleaned: boolean; messageId: string | null;
  reservedBytes: number; error: string; uploadExpiresAt: Date; expiresAt: Date; createdAt: Date;
}
export interface AttachmentQuota { _id: string; schemaVersion: 1; bytes: number; guardVersion: number; createdAt: Date }
export interface AttachmentCommand { _id: string; schemaVersion: 1; userId: string; digest: string; attachmentId: string; createdAt: Date }
export interface AttachmentJob { _id: string; schemaVersion: 1; state: 'pending' | 'claimed' | 'done' | 'failed'; attempts: number;
  leaseOwner: string | null; leaseUntil: Date; availableAt: Date; candidateKey: string | null; createdAt: Date }
export const attachmentReference = (row: AttachmentRecord): AttachmentReference => ({ id: row._id, name: row.name, kind: row.kind, size: row.state === 'ready' ? row.approvedSize : row.size });
export const attachmentView = (row: AttachmentRecord) => ({ ...attachmentReference(row), state: row.state, error: row.error, expiresAt: row.expiresAt.toISOString() });
export const contentTypes: Record<AttachmentKind, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf', text: 'text/plain; charset=utf-8' };
