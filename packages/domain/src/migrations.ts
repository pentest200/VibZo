import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import { migrateAuth } from './auth/migrations.js';
import { migrateConversations } from './conversations/migrations.js';
import { migrateMessaging } from './messaging/migrations.js';
import { migrateAttachments } from './attachments/migrations.js';
import { migrateSync } from './sync/migrations.js';
import { migrateSafety } from './safety/migrations.js';
import { migrateCalls } from './calls/migrations.js';
import { migrateOperations } from './operations/migrations.js';
import { migrateAvatars } from './avatars/migrations.js';
import { assertRecoveryReady } from './operations/recovery.js';
interface MigrationLease { _id:string;owner:string|null;leaseUntil:Date;epoch:number }
export async function runMigrations(db:Db):Promise<void> {
  await assertRecoveryReady(db);
  const owner=randomUUID();const locks=db.collection<MigrationLease>('migrationLocks');
  await locks.updateOne({_id:'schema'},{$setOnInsert:{owner:null,leaseUntil:new Date(0),epoch:0}},{upsert:true});
  const lease=await locks.findOneAndUpdate({_id:'schema',$expr:{$lte:['$leaseUntil','$$NOW']}},[
    {$set:{owner,leaseUntil:{$dateAdd:{startDate:'$$NOW',unit:'second',amount:120}},epoch:{$add:['$epoch',1]}}}
  ],{returnDocument:'after'});
  if(!lease)throw new Error('Another schema migration is running; retry after it completes');
  let lost=false;
  const assertLease=async()=>{
    if(lost)throw new Error('Migration lease was lost; no further DDL will run');
    const renewed=await locks.updateOne({_id:'schema',owner,epoch:lease.epoch,$expr:{$gt:['$leaseUntil','$$NOW']}},[
      {$set:{leaseUntil:{$dateAdd:{startDate:'$$NOW',unit:'second',amount:120}}}}
    ]);
    if(!renewed.matchedCount){lost=true;throw new Error('Migration lease expired; retry the idempotent migration');}
  };
  const heartbeat=setInterval(()=>{void assertLease().catch(()=>{lost=true;});},15000).unref();
  try {await assertLease();await migrateAuth(db);await assertLease();await migrateConversations(db,assertLease);await migrateMessaging(db,assertLease);await migrateSync(db,assertLease);await migrateAttachments(db,assertLease);await migrateSafety(db,assertLease);await migrateCalls(db,assertLease);await migrateOperations(db,assertLease);await migrateAvatars(db,assertLease);}
  finally {clearInterval(heartbeat);await locks.updateOne({_id:'schema',owner,epoch:lease.epoch},{$set:{owner:null,leaseUntil:new Date(0)}});}
}
