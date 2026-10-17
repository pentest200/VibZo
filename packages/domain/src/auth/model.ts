import type { Profile } from '@chat/contracts';
export interface UserRecord {
  _id: string; schemaVersion: 1; emailCanonical: string; usernameCanonical: string;
  displayName: string; passwordHash: string; verifiedAt: Date | null; privacy: Profile['privacy'];
  avatarId: string | null; role: 'user' | 'moderator'; authVersion: number; guardVersion: number;
  deletionState: 'active' | 'deleting' | 'deleted'; createdAt: Date; updatedAt: Date;
}
export interface SessionRecord {
  _id: string; schemaVersion: 1; tokenHash: string; csrfHash: string; userId: string; authVersion: number;
  deviceLabel: string; expiresAt: Date; revokedAt: Date | null; guardVersion: number; createdAt: Date;
}
export interface TokenRecord {
  _id: string; schemaVersion: 1; hash: string; userId: string; authVersion: number;
  purpose: 'verify' | 'reset'; expiresAt: Date; usedAt: Date | null; createdAt: Date;
}
export interface EmailJobRecord {
  _id: string; schemaVersion: 1; userId: string; state: 'pending' | 'sending' | 'sent' | 'dead';
  encryptedPayload: string | null; availableAt: Date; leaseUntil: Date; leaseOwner: string | null;
  attempts: number; createdAt: Date; expiresAt: Date; completedAt: Date | null;
}
export interface Principal { user: UserRecord; session: SessionRecord }
export function publicProfile(user: UserRecord): Profile {
  return { id: user._id, email: user.emailCanonical, username: user.usernameCanonical, displayName: user.displayName,
    verified: user.verifiedAt !== null, privacy: user.privacy, avatarId: user.avatarId };
}
