import type { Db } from 'mongodb';
export async function attachmentMetrics(db: Db) {
  const states = ['pending', 'claimed', 'failed'] as const;
  const counts = await Promise.all(states.map(state => db.collection('attachmentJobs').countDocuments({ state }, { maxTimeMS: 3000 })));
  const oldest = await db.collection('attachmentJobs').findOne({ state: { $in: ['pending', 'claimed', 'failed'] } }, { sort: { createdAt: 1 }, projection: { createdAt: 1 }, maxTimeMS: 3000 });
  return states.map((state, index) => `chat_attachment_jobs{state="${state}"} ${counts[index]}\n`).join('') + `chat_attachment_oldest_job_seconds ${oldest?.['createdAt'] instanceof Date ? Math.max(0, (Date.now() - oldest['createdAt'].getTime()) / 1000) : 0}\n`;
}
