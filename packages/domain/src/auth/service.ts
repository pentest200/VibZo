import { randomUUID } from 'node:crypto';
import type { ClientSession, Db, MongoClient } from 'mongodb';
import type { Config } from '@chat/config';
import type { AuthSession, RegisterInput, LoginInput, ProfileInput } from '@chat/contracts';
import { transactionOptions } from '../mongo.js';
import { csrfFor, newToken, PasswordHasher, sameSecret, seal, tokenHash } from './crypto.js';
import { DomainError, unauthorized, unavailable } from './errors.js';
import { authSchemaReady } from './migrations.js';
import type { EmailJobRecord, Principal, SessionRecord, TokenRecord, UserRecord } from './model.js';
import { publicProfile } from './model.js';
import { AuthRateLimiter } from './rate-limit.js';

export const GENERIC_AUTH_MESSAGE = 'If these details are eligible, an email will arrive with the next steps.';
export class AuthService {
  readonly passwords: PasswordHasher;
  readonly rates: AuthRateLimiter;
  constructor(readonly config: Config, readonly client: MongoClient, readonly db: Db) {
    this.passwords = new PasswordHasher(config); this.rates = new AuthRateLimiter(config);
  }
  async initialize(): Promise<void> {
    await this.passwords.initialize();
    try { await this.rates.connect(); } catch { /* auth mutations unavailable until process reconnect/restart */ }
  }
  async assertSchema(): Promise<void> { if (!await authSchemaReady(this.db)) throw unavailable(); }
  async close(): Promise<void> { await this.rates.close(); }
  private users() { return this.db.collection<UserRecord>('users'); }
  private sessions() { return this.db.collection<SessionRecord>('sessions'); }
  private tokens() { return this.db.collection<TokenRecord>('authTokens'); }
  private async transaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = this.client.startSession();
    try { return await session.withTransaction(() => operation(session), { ...transactionOptions, timeoutMS: 10000 }); }
    finally { await session.endSession(); }
  }
  async authenticate(rawToken: string | undefined, transaction?: ClientSession): Promise<Principal> {
    if (!rawToken || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) throw unauthorized();
    const active = { tokenHash: tokenHash(rawToken), revokedAt: null, expiresAt: { $gt: new Date() } };
    const candidate = await this.sessions().findOne(active, transaction ? { session: transaction } : {});
    if (!candidate) throw unauthorized();
    const userFilter = { _id: candidate.userId, authVersion: candidate.authVersion, deletionState: 'active' as const };
    const user = transaction
      ? await this.users().findOneAndUpdate(userFilter, { $inc: { guardVersion: 1 } }, { session: transaction, returnDocument: 'after' })
      : await this.users().findOne(userFilter);
    if (!user) throw unauthorized();
    const session = transaction
      ? await this.sessions().findOneAndUpdate(active, { $inc: { guardVersion: 1 } }, { session: transaction, returnDocument: 'after' })
      : candidate;
    if (!session) throw unauthorized();
    return { user, session };
  }
  assertCsrf(rawToken: string | undefined, supplied: string | undefined): void {
    if (!rawToken || !supplied || !sameSecret(csrfFor(rawToken, this.config.SESSION_SECRET), supplied)) throw new DomainError('FORBIDDEN', 'Please refresh and try again.', 403);
  }
  async current(rawToken: string | undefined): Promise<AuthSession> {
    const principal = await this.authenticate(rawToken);
    return { user: publicProfile(principal.user), csrfToken: csrfFor(rawToken!, this.config.SESSION_SECRET), sessionId: principal.session._id };
  }
  private async enqueueToken(user: UserRecord, purpose: 'verify' | 'reset', raw: string, session: ClientSession): Promise<void> {
    const now = new Date(); const expiresAt = new Date(now.getTime() + this.config.AUTH_TOKEN_MINUTES * 60000);
    // Invalidate earlier outstanding tokens for this purpose, serializing on the user guard.
    await this.tokens().updateMany({ userId: user._id, purpose, usedAt: null }, { $set: { usedAt: now } }, { session });
    await this.tokens().insertOne({ _id: randomUUID(), schemaVersion: 1, hash: tokenHash(raw), userId: user._id,
      authVersion: user.authVersion, purpose, expiresAt, usedAt: null, createdAt: now }, { session });
    const link = `${this.config.WEB_ORIGIN}/${purpose === 'verify' ? 'verify' : 'reset'}#token=${raw}`;
    const payload = JSON.stringify({ to: user.emailCanonical, subject: purpose === 'verify' ? 'Verify your Commonroom email' : 'Reset your Commonroom password',
      text: `${purpose === 'verify' ? 'Verify your email' : 'Reset your password'} using this one-use link (expires in ${this.config.AUTH_TOKEN_MINUTES} minutes):\n${link}\nIf you did not request this, ignore this email.` });
    await this.db.collection<EmailJobRecord>('authEmailJobs').insertOne({ _id: randomUUID(), schemaVersion: 1, userId: user._id, state: 'pending', encryptedPayload: seal(payload, this.config.AUTH_EMAIL_KEY),
      availableAt: now, leaseUntil: new Date(0), leaseOwner: null, attempts: 0, createdAt: now, expiresAt, completedAt: null }, { session });
  }
  async register(input: RegisterInput): Promise<void> {
    // Always hash valid registrations, including duplicates. No account existence in response.
    const passwordHash = await this.passwords.hash(input.password); const raw = newToken(); const now = new Date();
    const user: UserRecord = { _id: randomUUID(), schemaVersion: 1, emailCanonical: input.email, usernameCanonical: input.username,
      passwordHash, displayName: input.displayName, verifiedAt: null, privacy: { showPresence: true, allowSearch: true }, avatarId: null,
      role: 'user', authVersion: 1, guardVersion: 0, deletionState: 'active', createdAt: now, updatedAt: now };
    try {
      await this.transaction(async session => { await this.users().insertOne(user, { session }); await this.enqueueToken(user, 'verify', raw, session); });
    } catch (error) { if ((error as { code?: number }).code !== 11000) throw error; }
  }
  async login(input: LoginInput, previousToken?: string): Promise<{ token: string; session: AuthSession }> {
    const candidate = await this.users().findOne({ emailCanonical: input.email, deletionState: 'active' });
    if (!await this.passwords.verify(candidate?.passwordHash, input.password) || !candidate) throw new DomainError('UNAUTHENTICATED', 'Email or password is incorrect.', 401);
    const token = newToken(); const csrfToken = csrfFor(token, this.config.SESSION_SECRET); const id = randomUUID(); const now = new Date();
    const user = await this.transaction(async transaction => {
      const locked = await this.users().findOneAndUpdate({ _id: candidate._id, passwordHash: candidate.passwordHash, authVersion: candidate.authVersion }, { $inc: { guardVersion: 1 } }, { session: transaction, returnDocument: 'after' });
      if (!locked) throw unauthorized();
      // Rotate a same-account session. Cross-account tokens are never an authority to revoke another user's session.
      if (previousToken) await this.sessions().updateOne({ tokenHash: tokenHash(previousToken), userId: locked._id }, { $set: { revokedAt: now } }, { session: transaction });
      const count = await this.sessions().countDocuments({ userId: locked._id, revokedAt: null, expiresAt: { $gt: now } }, { session: transaction });
      if (count >= this.config.MAX_SESSIONS) throw new DomainError('CONFLICT', 'Your active session limit is reached. Sign out on another device or reset your password.', 409);
      await this.sessions().insertOne({ _id: id, schemaVersion: 1, tokenHash: tokenHash(token), csrfHash: tokenHash(csrfToken), userId: locked._id,
        authVersion: locked.authVersion, deviceLabel: input.deviceLabel, expiresAt: new Date(now.getTime() + this.config.SESSION_DURATION_HOURS * 3600000), revokedAt: null, guardVersion: 0, createdAt: now }, { session: transaction });
      return locked;
    });
    return { token, session: { user: publicProfile(user), csrfToken, sessionId: id } };
  }
  async listSessions(rawToken: string | undefined) {
    const principal = await this.authenticate(rawToken);
    const records = await this.sessions().find({ userId: principal.user._id, revokedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1, _id: -1 }).limit(this.config.MAX_SESSIONS).toArray();
    return records.map(record => ({ id: record._id, deviceLabel: record.deviceLabel, createdAt: record.createdAt.toISOString(), expiresAt: record.expiresAt.toISOString(), current: record._id === principal.session._id }));
  }
  private async audit(actorId: string, action: string, targetId: string, session: ClientSession) {
    await this.db.collection<{ _id: string; schemaVersion: 1; createdAt: Date; actorId: string; action: string; targetId: string }>('auditEvents')
      .insertOne({ _id: randomUUID(), schemaVersion: 1, createdAt: new Date(), actorId, action, targetId }, { session });
  }
  async revoke(rawToken: string | undefined, target: 'current' | 'all' | string): Promise<void> {
    const userId = await this.transaction(async transaction => {
      const principal = await this.authenticate(rawToken, transaction);
      if (target === 'all') {
        await this.users().updateOne({ _id: principal.user._id }, { $inc: { authVersion: 1 } }, { session: transaction });
        await this.sessions().updateMany({ userId: principal.user._id, revokedAt: null }, { $set: { revokedAt: new Date() } }, { session: transaction });
      } else {
        const id = target === 'current' ? principal.session._id : target;
        const result = await this.sessions().updateOne({ _id: id, userId: principal.user._id }, { $set: { revokedAt: new Date() } }, { session: transaction });
        if (!result.matchedCount) throw new DomainError('FORBIDDEN', 'That session is unavailable.', 403);
      }
      await this.audit(principal.user._id, `session.revoke.${target === 'all' ? 'all' : 'one'}`, principal.user._id, transaction);
      return principal.user._id;
    });
    await this.rates.revocationHint(userId);
  }
  async requestReset(email: string): Promise<void> {
    const raw = newToken();
    await this.transaction(async session => {
      const user = await this.users().findOneAndUpdate({ emailCanonical: email, deletionState: 'active' }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' });
      if (user) await this.enqueueToken(user, 'reset', raw, session);
    });
  }
  async resendVerification(rawToken: string | undefined): Promise<void> {
    const raw = newToken();
    await this.transaction(async session => {
      const principal = await this.authenticate(rawToken, session);
      if (!principal.user.verifiedAt) await this.enqueueToken(principal.user, 'verify', raw, session);
    });
  }
  async consumeToken(raw: string, purpose: 'verify' | 'reset', password?: string): Promise<void> {
    const passwordHash = password === undefined ? undefined : await this.passwords.hash(password);
    const userId = await this.transaction(async session => {
      const now = new Date();
      const candidate = await this.tokens().findOne({ hash: tokenHash(raw), purpose, usedAt: null, expiresAt: { $gt: now } }, { session });
      if (!candidate) throw new DomainError('INVALID_INPUT', 'This link is invalid or expired. Request a new email.', 400);
      const user = await this.users().findOneAndUpdate({ _id: candidate.userId, authVersion: candidate.authVersion, deletionState: 'active' }, { $inc: { guardVersion: 1 } }, { session, returnDocument: 'after' });
      if (!user) throw new DomainError('INVALID_INPUT', 'This link is invalid or expired. Request a new email.', 400);
      const consumed = await this.tokens().updateOne({ _id: candidate._id, usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } }, { session });
      if (!consumed.modifiedCount) throw new DomainError('INVALID_INPUT', 'This link is invalid or expired. Request a new email.', 400);
      if (purpose === 'verify') await this.users().updateOne({ _id: user._id }, { $set: { verifiedAt: now, updatedAt: now } }, { session });
      else {
        if (!passwordHash) throw new DomainError('INVALID_INPUT', 'Choose a new password.', 400);
        await this.users().updateOne({ _id: user._id }, { $set: { passwordHash, updatedAt: now }, $inc: { authVersion: 1 } }, { session });
        await this.sessions().updateMany({ userId: user._id, revokedAt: null }, { $set: { revokedAt: now } }, { session });
        await this.tokens().updateMany({ userId: user._id, usedAt: null }, { $set: { usedAt: now } }, { session });
      }
      await this.audit(user._id, `auth.${purpose}.consume`, user._id, session);
      return user._id;
    });
    if (purpose === 'reset') await this.rates.revocationHint(userId);
  }
  async changePassword(rawToken: string | undefined, currentPassword: string, password: string): Promise<void> {
    const principal = await this.authenticate(rawToken);
    if (!await this.passwords.verify(principal.user.passwordHash, currentPassword)) throw new DomainError('INVALID_INPUT', 'Current password is incorrect.', 400);
    const passwordHash = await this.passwords.hash(password);
    const userId = await this.transaction(async session => {
      const locked = await this.authenticate(rawToken, session);
      if (locked.user.passwordHash !== principal.user.passwordHash) throw unauthorized();
      const now = new Date();
      await this.users().updateOne({ _id: locked.user._id }, { $set: { passwordHash, updatedAt: now }, $inc: { authVersion: 1 } }, { session });
      await this.sessions().updateMany({ userId: locked.user._id, revokedAt: null }, { $set: { revokedAt: now } }, { session });
      await this.tokens().updateMany({ userId: locked.user._id, usedAt: null }, { $set: { usedAt: now } }, { session });
      await this.audit(locked.user._id, 'auth.password.change', locked.user._id, session); return locked.user._id;
    });
    await this.rates.revocationHint(userId);
  }
  async updateProfile(rawToken: string | undefined, input: ProfileInput) {
    try {
      return await this.transaction(async session => {
        const principal = await this.authenticate(rawToken, session);
        const user = await this.users().findOneAndUpdate({ _id: principal.user._id }, { $set: { usernameCanonical: input.username, displayName: input.displayName, privacy: input.privacy, updatedAt: new Date() } }, { session, returnDocument: 'after' });
        if (!user) throw unauthorized(); return publicProfile(user);
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new DomainError('CONFLICT', 'That username is already in use.', 409);
      throw error;
    }
  }
}
export function requireVerified(principal: Principal): void {
  if (!principal.user.verifiedAt) throw new DomainError('FORBIDDEN', 'Verify your email to continue.', 403);
}
export function requireModerator(principal: Principal): void {
  requireVerified(principal);
  if (principal.user.role !== 'moderator') throw new DomainError('FORBIDDEN', 'This action is unavailable.', 403);
}
