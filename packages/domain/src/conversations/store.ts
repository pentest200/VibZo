import { randomUUID } from 'node:crypto';
import { traceCarrier } from '@chat/observability';
import { Long } from 'mongodb';
import type { ClientSession } from 'mongodb';
import { MAX_SEQUENCE } from '@chat/contracts';
import type { AuthService } from '../auth/service.js';
import { requireVerified } from '../auth/service.js';
import type { Principal } from '../auth/model.js';
import type { UserRecord } from '../auth/model.js';
import { DomainError, unavailable } from '../auth/errors.js';
import { transactionOptions } from '../mongo.js';
import { conversationSchemaReady } from './migrations.js';
import { membershipId, pairId } from './model.js';
import type { Admission } from '../messaging/model.js';
import type { ConversationRecord, MembershipRecord, PairRecord, InboxCounter, InboxEvent, ControlEvent, OutboxRecord } from './model.js';

export const denied = () => new DomainError('FORBIDDEN','This conversation or action is unavailable.',403);
export const conflict = (message:string) => new DomainError('CONFLICT',message,409);
export const maxLong = Long.fromString(MAX_SEQUENCE.toString());
export interface ConversationContext { principal:Principal; conversation:ConversationRecord; membership:MembershipRecord; session:ClientSession }
export class ConversationStore {
  constructor(readonly auth:AuthService) {}
  get db(){return this.auth.db;}
  conversations(){return this.db.collection<ConversationRecord>('conversations');}
  members(){return this.db.collection<MembershipRecord>('memberships');}
  async run<T>(operation:(session:ClientSession)=>Promise<T>):Promise<T>{
    if(!await conversationSchemaReady(this.db))throw unavailable();
    const deadline=Date.now()+10000;
    for(let attempt=0;;attempt++){
      const session=this.auth.client.startSession();
      try{return await session.withTransaction(()=>operation(session),{...transactionOptions,timeoutMS:Math.max(1,deadline-Date.now())});}
      catch(error){
        // First-use pair/counter upserts can race on unique keys; safe commands re-read canonical state.
        if((error as {code?:number}).code!==11000 || attempt>=2 || Date.now()>=deadline)throw error;
      }finally{await session.endSession();}
    }
  }
  async actor(token:string|undefined,session:ClientSession):Promise<Principal>{
    const principal=await this.auth.authenticate(token,session);requireVerified(principal);return principal;
  }
  async guardPair(a:string,b:string,session:ClientSession,allowBlocked=false):Promise<PairRecord>{
    const id=pairId(a,b);
    const pair=await this.db.collection<PairRecord>('pairGuards').findOneAndUpdate({_id:id},
      {$setOnInsert:{schemaVersion:1,userIds:[a,b].sort(),blockedBy:[],createdAt:new Date()},$inc:{guardVersion:1}},
      {upsert:true,returnDocument:'after',session});
    if(!pair || (!allowBlocked && pair.blockedBy.length))throw denied();return pair;
  }
  async authorize(token:string|undefined,id:string,session:ClientSession,mode:'history'|'write'='history'):Promise<ConversationContext>{
    const principal=await this.actor(token,session);
    const conversation=await this.conversations().findOneAndUpdate({_id:id,state:'active'},{$inc:{guardVersion:1}},{session,returnDocument:'after'});
    if(!conversation)throw denied();
    const membership=await this.members().findOneAndUpdate({_id:membershipId(id,principal.user._id),state:'active'},{$inc:{guardVersion:1}},{session,returnDocument:'after'});
    if(!membership)throw denied();
    if(conversation.kind==='direct'){
      const ids=conversation.directPair!.split(':');const other=ids.find(userId=>userId!==principal.user._id);
      if(!other)throw denied();await this.guardPair(principal.user._id,other,session,mode==='history');
      if(mode==='write'&&!await this.db.collection<UserRecord>('users').findOneAndUpdate({_id:other,deletionState:'active'},{$inc:{guardVersion:1}},{session}))throw denied();
    }
    return {principal,conversation,membership,session};
  }
  async inboxCounter(userId:string,session:ClientSession):Promise<InboxCounter>{
    const counter=await this.db.collection<InboxCounter>('inboxCounters').findOneAndUpdate({_id:userId},
      {$setOnInsert:{schemaVersion:1,createdAt:new Date(),sequence:Long.ZERO},$inc:{guardVersion:1}},
      {upsert:true,returnDocument:'after',session});
    if(!counter)throw unavailable();return counter;
  }
  async notify(userIds:string[],conversationId:string|null,session:ClientSession,kind:InboxEvent['kind']='conversation.changed'):Promise<void>{
    for(const userId of [...new Set(userIds)].sort()){
      await this.inboxCounter(userId,session);
      const counter=await this.db.collection<InboxCounter>('inboxCounters').findOneAndUpdate({_id:userId,sequence:{$lt:maxLong}},{$inc:{sequence:Long.ONE}},{session,returnDocument:'after'});
      if(!counter)throw conflict('Inbox sequence is exhausted.');
      await this.db.collection<InboxEvent>('inboxEvents').insertOne({_id:randomUUID(),schemaVersion:1,userId,sequence:counter.sequence,conversationId,kind,createdAt:new Date()},{session});
    }
  }
  async event(conversationId:string,actorId:string,kind:string,payload:Record<string,string>,session:ClientSession,extraUsers:string[]=[],eventId=randomUUID()):Promise<Long>{
    // All upgraded writers and publication completion serialize on the same real write.
    const admission=await this.db.collection<Admission>('outboxAdmission').updateOne({_id:'global'},{$inc:{guardVersion:1}},{session});
    if(!admission.matchedCount)throw unavailable();
    const pending=await this.db.collection<OutboxRecord>('outbox').countDocuments({status:{$in:['pending','claimed']}},{session,limit:this.auth.config.MAX_PENDING_OUTBOX});
    if(pending>=this.auth.config.MAX_PENDING_OUTBOX)throw unavailable();
    const conversation=await this.conversations().findOneAndUpdate({_id:conversationId,nextEventSeq:{$lt:maxLong}},{$inc:{nextEventSeq:Long.ONE},$set:{updatedAt:new Date()}},{session,returnDocument:'after'});
    if(!conversation)throw conflict('Conversation sequence is exhausted.');
    const now=new Date();
    if (kind === 'message.created') await this.members().updateMany({ conversationId, hidden: true, state: 'active' }, { $set: { hidden: false } }, { session });
    await this.db.collection<ControlEvent>('conversationEvents').insertOne({_id:eventId,schemaVersion:1,conversationId,sequence:conversation.nextEventSeq,actorId,kind,payload,createdAt:now},{session});
    const carrier=traceCarrier();
    // New code can precede DDL during an overlap: omit optional fields until 008.
    const traceparent=carrier['traceparent']&&await this.db.collection<{_id:string}>('schemaMigrations').findOne({_id:'008_operations'},{session})?carrier['traceparent']:undefined;
    await this.db.collection<OutboxRecord>('outbox').insertOne({_id:eventId,schemaVersion:1,eventId,topic:'conversation.event.v1',status:'pending',availableAt:now,leaseUntil:new Date(0),leaseOwner:null,attempts:0,publishedAt:null,createdAt:now,...(traceparent?{traceparent}:{})},{session});
    const memberLimit=conversation.kind==='direct'?2:this.auth.config.MAX_GROUP_MEMBERS;
    const recipients=await this.members().find({conversationId,$or:[{state:'active'},{state:'invited',invitationExpiresAt:{$gt:now}}]},{session}).limit(memberLimit+1).toArray();
    if(recipients.length>memberLimit)throw conflict('Conversation membership limit is exceeded.');
    await this.notify([...extraUsers,...recipients.map(member=>member.userId)],conversationId,session);
    return conversation.nextEventSeq;
  }
  async accountCapacity(userId:string,session:ClientSession):Promise<void>{
    // Counter lock serializes concurrent invitations/direct/group creations for this recipient.
    await this.inboxCounter(userId,session);
    const count=await this.members().countDocuments({userId,$or:[{state:'active'},{state:'invited',invitationExpiresAt:{$gt:new Date()}}]},{session,limit:this.auth.config.MAX_CONVERSATIONS_PER_USER});
    if(count>=this.auth.config.MAX_CONVERSATIONS_PER_USER)throw conflict('The account conversation limit has been reached.');
  }
}
