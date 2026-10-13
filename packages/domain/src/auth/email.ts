import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import { z } from 'zod';
import type { Db } from 'mongodb';
import type { Config } from '@chat/config';
import type { EmailJobRecord } from './model.js';
import { unseal } from './crypto.js';
const emailPayload = z.strictObject({ to: z.email(), subject: z.string().max(100), text: z.string().max(4000) });
export interface EmailProvider { send(jobId: string, payload: z.infer<typeof emailPayload>): Promise<void> }
export function smtpProvider(config: Config): EmailProvider {
  const transport = nodemailer.createTransport({ host: config.SMTP_HOST, port: config.SMTP_PORT, secure: config.SMTP_SECURE,
    ...(config.SMTP_USER && config.SMTP_PASSWORD ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}),
    connectionTimeout: 5000, greetingTimeout: 5000, socketTimeout: 5000, disableFileAccess: true, disableUrlAccess: true });
  return { async send(jobId, payload) {
    const result = await transport.sendMail({ from: config.EMAIL_FROM, to: payload.to, subject: payload.subject,
      text: payload.text, messageId: `<${jobId}@commonroom.example.test>` });
    if (!result.accepted?.length || result.rejected?.length) throw new Error('Email provider rejected recipient');
  } };
}
export class AuthEmailWorker {
  private readonly owner = randomUUID();
  constructor(private readonly db: Db, private readonly config: Config, private readonly provider: EmailProvider = smtpProvider(config)) {}
  async runOnce(): Promise<boolean> {
    const jobs = this.db.collection<EmailJobRecord>('authEmailJobs'); const now = new Date();
    await jobs.updateMany({ state: { $in: ['pending','sending'] }, expiresAt: { $lte: now }, leaseUntil: { $lte: now } },
      { $set: { state: 'dead', encryptedPayload: null, completedAt: now, leaseOwner: null } });
    await jobs.updateMany({ state: 'sending', attempts: { $gte: 5 }, leaseUntil: { $lte: now } },
      { $set: { state: 'dead', encryptedPayload: null, completedAt: now, leaseOwner: null } });
    const job = await jobs.findOneAndUpdate({ state: { $in: ['pending','sending'] }, availableAt: { $lte: now },
      expiresAt: { $gt: now }, leaseUntil: { $lte: now }, attempts: { $lt: 5 } },
      { $set: { state: 'sending', leaseOwner: this.owner, leaseUntil: new Date(now.getTime() + 30000) }, $inc: { attempts: 1 } },
      { returnDocument: 'after', sort: { availableAt: 1, _id: 1 } });
    if (!job) return false;
    try {
      if (!job.encryptedPayload) throw new Error('Missing payload');
      const payload = emailPayload.parse(JSON.parse(unseal(job.encryptedPayload, this.config.AUTH_EMAIL_KEY)));
      await this.provider.send(job._id, payload);
      // Provider acceptance precedes completion. A crash here may duplicate SMTP delivery.
      await jobs.updateOne({ _id: job._id, state: 'sending', leaseOwner: this.owner },
        { $set: { state: 'sent', encryptedPayload: null, completedAt: new Date(), leaseOwner: null, leaseUntil: new Date(0) } });
    } catch {
      const dead = job.attempts >= 5;
      await jobs.updateOne({ _id: job._id, state: 'sending', leaseOwner: this.owner }, { $set: {
        state: dead ? 'dead' : 'pending', leaseOwner: null, leaseUntil: new Date(0),
        availableAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** job.attempts) + Math.floor(Math.random() * 1000)),
        ...(dead ? { completedAt: new Date(), encryptedPayload: null } : {})
      } });
    }
    return true;
  }
}
