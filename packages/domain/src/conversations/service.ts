import { messageAttachments } from '../attachments/store.js';
import { randomUUID } from 'node:crypto';
import { Long } from 'mongodb';
import type { ClientSession, Filter } from 'mongodb';
import type { Conversation } from '@chat/contracts';
import { longToSequence, sequenceToLong } from '../sequence.js';
import { tokenHash } from '../auth/crypto.js';
import type { UserRecord } from '../auth/model.js';
import { DomainError } from '../auth/errors.js';
import { ConversationStore, denied, conflict } from './store.js';
import type { ConversationContext } from './store.js';
import { membershipId, pairId, publicUser } from './model.js';
import type { MembershipRecord, VisibilityRecord, CreateCommand, BlockRecord, PairRecord, InboxEvent, MessageRecord } from './model.js';

export class ConversationService extends ConversationStore {
  async authorizedOperation<T>(token:string|undefined,id:string,operation:(context:ConversationContext)=>Promise<T>):Promise<T>{
    return this.run(async session=>operation(await this.authorize(token,id,session,'write')));
  }
  private async target(userId:string,session:ClientSession,discoverable=true):Promise<UserRecord>{
    const user=await this.db.collection<UserRecord>('users').findOne({_id:userId,deletionState:'active',verifiedAt:{$ne:null},...(discoverable?{'privacy.allowSearch':true}:{})},{session});
    if(!user)throw denied();return user;
  }
  private async addMember(conversationId:string,userId:string,role:MembershipRecord['role'],state:'active'|'invited',inviterId:string|null,session:ClientSession){
    const now=new Date();const record:MembershipRecord={_id:membershipId(conversationId,userId),schemaVersion:1,conversationId,userId,role,state,guardVersion:0,inviterId,
      invitationExpiresAt:state==='invited'?new Date(now.getTime()+this.auth.config.GROUP_INVITATION_HOURS*3600000):null,createdAt:now,updatedAt:now};
    await this.members().replaceOne({_id:record._id},record,{upsert:true,session});
  }
  private async openWindow(conversationId:string,userId:string,sequence:Long,session:ClientSession){
    await this.db.collection<VisibilityRecord>('visibilityIntervals').insertOne({_id:randomUUID(),schemaVersion:1,conversationId,userId,startSeq:sequence,endSeq:null,createdAt:new Date()},{session});
  }
  async search(token:string|undefined,prefix:string,after:string|undefined,limit:number){
    if(after && !after.startsWith(prefix))throw new DomainError('INVALID_INPUT','The search cursor does not match this prefix.',400);
    return this.run(async session=>{
      const principal=await this.actor(token,session);
      const candidates=await this.db.collection<UserRecord>('users').find({usernameCanonical:{$gte:prefix,$lt:`${prefix}{`,...(after?{$gt:after}:{})},_id:{$ne:principal.user._id},
        deletionState:'active',verifiedAt:{$ne:null},'privacy.allowSearch':true},{session}).sort({usernameCanonical:1}).limit(limit+1).toArray();
      const page=candidates.slice(0,limit);
      const pairs=await this.db.collection<PairRecord>('pairGuards').find({_id:{$in:page.map(user=>pairId(principal.user._id,user._id))},'blockedBy.0':{$exists:true}},{session}).toArray();
      const hidden=new Set(pairs.map(pair=>pair._id));
      return {users:page.filter(user=>!hidden.has(pairId(principal.user._id,user._id))).map(publicUser),nextCursor:candidates.length>limit?page.at(-1)!.usernameCanonical:null};
    });
  }
  async createDirect(token:string|undefined,targetId:string){
    const id=randomUUID();
    return this.run(async session=>{
      const principal=await this.actor(token,session),actorId=principal.user._id;if(actorId===targetId)throw denied();
      await this.guardPair(actorId,targetId,session);
      const existing=await this.conversations().findOne({kind:'direct',directPair:pairId(actorId,targetId)},{session});
      if(existing){await this.authorize(token,existing._id,session,'write');return {conversationId:existing._id};}
      await this.target(targetId,session);
      for(const userId of [actorId,targetId].sort())await this.accountCapacity(userId,session);
      const now=new Date();
      await this.conversations().insertOne({_id:id,schemaVersion:1,kind:'direct',title:'',directPair:pairId(actorId,targetId),state:'active',nextEventSeq:Long.ZERO,guardVersion:0,createdAt:now,updatedAt:now},{session});
      await this.addMember(id,actorId,'member','active',null,session);await this.addMember(id,targetId,'member','active',null,session);
      const sequence=await this.event(id,actorId,'conversation.created',{},session);
      await this.openWindow(id,actorId,sequence,session);await this.openWindow(id,targetId,sequence,session);
      return {conversationId:id};
    });
  }
  async createGroup(token:string|undefined,clientCommandId:string,title:string){
    const id=randomUUID(),digest=tokenHash(JSON.stringify({kind:'group',title}));
    return this.run(async session=>{
      const principal=await this.actor(token,session),userId=principal.user._id;
      const command=await this.db.collection<CreateCommand>('conversationCommands').findOne({userId,clientCommandId},{session});
      if(command){if(command.digest!==digest)throw conflict('This command ID was already used with different content.');return {conversationId:command.conversationId};}
      await this.accountCapacity(userId,session);const now=new Date();
      await this.conversations().insertOne({_id:id,schemaVersion:1,kind:'group',title,directPair:null,state:'active',nextEventSeq:Long.ZERO,guardVersion:0,createdAt:now,updatedAt:now},{session});
      await this.addMember(id,userId,'owner','active',null,session);
      const sequence=await this.event(id,userId,'conversation.created',{title},session);await this.openWindow(id,userId,sequence,session);
      await this.db.collection<CreateCommand>('conversationCommands').insertOne({_id:randomUUID(),schemaVersion:1,userId,clientCommandId,digest,conversationId:id,createdAt:now},{session});
      return {conversationId:id};
    });
  }
  private requireManager(context:ConversationContext){if(context.conversation.kind!=='group'||context.membership.role==='member')throw denied();}
  async invite(token:string|undefined,id:string,targetId:string):Promise<void>{
    await this.run(async session=>{
      const context=await this.authorize(token,id,session,'write');this.requireManager(context);
      const current=await this.members().findOne({_id:membershipId(id,targetId)},{session});
      if(current?.state==='active'||(current?.state==='invited'&&current.invitationExpiresAt!>new Date()))return;
      await this.guardPair(context.principal.user._id,targetId,session);await this.target(targetId,session);
      await this.accountCapacity(targetId,session);
      const count=await this.members().countDocuments({conversationId:id,$or:[{state:'active'},{state:'invited',invitationExpiresAt:{$gt:new Date()}}]},{session,limit:this.auth.config.MAX_GROUP_MEMBERS});
      if(count>=this.auth.config.MAX_GROUP_MEMBERS)throw conflict('The group member limit has been reached.');
      await this.addMember(id,targetId,'member','invited',context.principal.user._id,session);
      await this.event(id,context.principal.user._id,'member.invited',{targetUserId:targetId},session);
    });
  }
  async respondInvitation(token:string|undefined,id:string,accept:boolean):Promise<void>{
    await this.run(async session=>{
      const principal=await this.actor(token,session),userId=principal.user._id;
      const conversation=await this.conversations().findOneAndUpdate({_id:id,kind:'group',state:'active'},{$inc:{guardVersion:1}},{session,returnDocument:'after'});
      if(!conversation)throw denied();
      const member=await this.members().findOneAndUpdate({_id:membershipId(id,userId)},{$inc:{guardVersion:1}},{session,returnDocument:'after'});
      if(member?.state==='active'&&accept)return;
      if(member?.state==='left'&&!accept)return;
      if(!member||member.state!=='invited'||!member.invitationExpiresAt||member.invitationExpiresAt<=new Date())throw denied();
      if(accept){await this.guardPair(userId,member.inviterId!,session);}
      await this.members().updateOne({_id:member._id},{$set:{state:accept?'active':'left',invitationExpiresAt:null,updatedAt:new Date()}},{session});
      const seq=await this.event(id,userId,accept?'member.joined':'member.declined',{targetUserId:userId},session,[userId]);
      if(accept)await this.openWindow(id,userId,seq,session);
    });
  }
  async changeRole(token:string|undefined,id:string,targetId:string,role:'admin'|'member'):Promise<void>{
    await this.run(async session=>{
      const ctx=await this.authorize(token,id,session,'write');this.requireManager(ctx);if(ctx.membership.role!=='owner')throw denied();
      const target=await this.members().findOne({_id:membershipId(id,targetId),state:'active'},{session});
      if(!target||target.role==='owner')throw denied();if(target.role===role)return;
      await this.members().updateOne({_id:target._id},{$set:{role,updatedAt:new Date()},$inc:{guardVersion:1}},{session});
      await this.event(id,ctx.principal.user._id,'member.role_changed',{targetUserId:targetId,role},session);
    });
  }
  async transferOwner(token:string|undefined,id:string,targetId:string):Promise<void>{
    await this.run(async session=>{
      const ctx=await this.authorize(token,id,session,'write');this.requireManager(ctx);if(ctx.membership.role!=='owner'||targetId===ctx.principal.user._id)throw denied();
      const target=await this.members().findOne({_id:membershipId(id,targetId),state:'active'},{session});if(!target)throw denied();
      await this.members().updateOne({_id:target._id},{$set:{role:'owner',updatedAt:new Date()},$inc:{guardVersion:1}},{session});
      await this.members().updateOne({_id:ctx.membership._id},{$set:{role:'admin',updatedAt:new Date()}},{session});
      await this.event(id,ctx.principal.user._id,'owner.transferred',{targetUserId:targetId},session);
    });
  }
  async rename(token:string|undefined,id:string,title:string):Promise<void>{
    await this.run(async session=>{
      const ctx=await this.authorize(token,id,session,'write');this.requireManager(ctx);if(ctx.conversation.title===title)return;
      await this.conversations().updateOne({_id:id},{$set:{title}},{session});await this.event(id,ctx.principal.user._id,'conversation.renamed',{title},session);
    });
  }
  async remove(token:string|undefined,id:string,targetId:string|undefined):Promise<void>{
    await this.run(async session=>{
      const ctx=await this.authorize(token,id,session,'write');if(ctx.conversation.kind!=='group')throw denied();
      const actorId=ctx.principal.user._id,userId=targetId??actorId,leaving=userId===actorId;
      const target=await this.members().findOneAndUpdate({_id:membershipId(id,userId)},{$inc:{guardVersion:1}},{session,returnDocument:'after'});
      if(!target)throw denied();
      if(!leaving){this.requireManager(ctx);if(target.role==='owner'||(ctx.membership.role==='admin'&&target.role==='admin'))throw denied();}
      if(!['active','invited'].includes(target.state))return;
      if(target.role==='owner'){
        const active=await this.members().countDocuments({conversationId:id,state:'active'},{session,limit:2});
        if(active>1)throw conflict('Transfer ownership before leaving the group.');
        await this.conversations().updateOne({_id:id},{$set:{state:'archived'}},{session});
      }
      await this.members().updateOne({_id:target._id},{$set:{state:leaving?'left':'removed',invitationExpiresAt:null,updatedAt:new Date()}},{session});
      const seq=await this.event(id,actorId,leaving?'member.left':'member.removed',{targetUserId:userId},session,[userId]);
      await this.db.collection<VisibilityRecord>('visibilityIntervals').updateOne({conversationId:id,userId,endSeq:null},{$set:{endSeq:seq}},{session});
      if(target.role==='owner'){
        const invited=await this.members().find({conversationId:id,state:'invited'},{session}).limit(this.auth.config.MAX_GROUP_MEMBERS).toArray();
        await this.members().updateMany({conversationId:id,state:'invited'},{$set:{state:'removed',invitationExpiresAt:null,updatedAt:new Date()}},{session});
        await this.notify(invited.map(row=>row.userId),id,session);
      }
    });
  }
  async setBlock(token:string|undefined,targetId:string,blocked:boolean):Promise<void>{
    await this.run(async session=>{
      const principal=await this.actor(token,session),userId=principal.user._id;if(userId===targetId)throw denied();
      await this.target(targetId,session,false);await this.guardPair(userId,targetId,session,true);
      const blocks=this.db.collection<BlockRecord>('blocks'),key={blockerId:userId,blockedId:targetId};
      const previous=await blocks.findOne(key,{session});if(!!previous===blocked)return;
      if(blocked){
        const count=await blocks.countDocuments({blockerId:userId},{session,limit:this.auth.config.MAX_BLOCKS_PER_USER});
        if(count>=this.auth.config.MAX_BLOCKS_PER_USER)throw conflict('The block list limit has been reached.');
        await blocks.insertOne({_id:pairId(userId,targetId)+':'+userId,schemaVersion:1,...key,createdAt:new Date()},{session});
        await this.db.collection<PairRecord>('pairGuards').updateOne({_id:pairId(userId,targetId)},{$addToSet:{blockedBy:userId}},{session});
      }else{
        await blocks.deleteOne(key,{session});await this.db.collection<PairRecord>('pairGuards').updateOne({_id:pairId(userId,targetId)},{$pull:{blockedBy:userId}},{session});
      }
      await this.notify([userId,targetId],null,session,'blocks.changed');
    });
  }
  async listBlocks(token:string|undefined,after:string|undefined,limit:number){
    return this.run(async session=>{
      const principal=await this.actor(token,session);
      const records=await this.db.collection<BlockRecord>('blocks').find({blockerId:principal.user._id,...(after?{blockedId:{$gt:after}}:{})},{session}).sort({blockedId:1}).limit(limit+1).toArray();
      const page=records.slice(0,limit),users=await this.db.collection<UserRecord>('users').find({_id:{$in:page.map(row=>row.blockedId)}},{session}).toArray();const byId=new Map(users.map(user=>[user._id,user]));
      return {users:page.flatMap(row=>{const user=byId.get(row.blockedId);return user?[publicUser(user)]:[];}),nextCursor:records.length>limit?page.at(-1)!.blockedId:null};
    });
  }
  private visibleMemberships(userId:string):Filter<MembershipRecord>{return {userId,$or:[{state:'active'},{state:'invited',invitationExpiresAt:{$gt:new Date()}}]};}
  async inbox(token:string|undefined,after:string|undefined,limit:number){
    return this.run(async session=>{
      const principal=await this.actor(token,session),userId=principal.user._id;
      const counter=await this.inboxCounter(userId,session);
      const members=await this.members().find({...this.visibleMemberships(userId),...(after?{conversationId:{$gt:after}}:{})},{session}).sort({conversationId:1}).limit(limit+1).toArray();
      const page=members.slice(0,limit),conversations=await this.conversations().find({_id:{$in:page.map(member=>member.conversationId)},state:'active'},{session}).toArray();
      const map=new Map(conversations.map(conversation=>[conversation._id,conversation]));
      const items=[];
      for(const member of page){
        const conversation=map.get(member.conversationId);if(!conversation)continue;
        const otherId=conversation.directPair?.split(':').find(id=>id!==userId)??null;
        const other=otherId?await this.target(otherId,session,false):null;
        items.push({id:conversation._id,kind:conversation.kind,title:other?.displayName??conversation.title,state:member.state as 'active'|'invited',role:member.role,otherUserId:otherId,updatedAt:conversation.updatedAt.toISOString()});
      }
      return {items,nextCursor:members.length>limit?page.at(-1)!.conversationId:null,watermark:longToSequence(counter.sequence)};
    });
  }
  async inboxFeed(token:string|undefined,after:string,through:string|undefined,limit:number){
    return this.run(async session=>{
      const principal=await this.actor(token,session),counter=await this.inboxCounter(principal.user._id,session);
      const floor=await this.db.collection<{_id:string;floor:Long}>('replayFloors').findOne({_id:`inbox:${principal.user._id}`},{session});
      if(floor&&sequenceToLong(after).lessThan(floor.floor))throw new DomainError('CURSOR_EXPIRED','Refresh the inbox snapshot to continue.',409);
      const watermark=through?sequenceToLong(through):counter.sequence;
      if(watermark.greaterThan(counter.sequence)||sequenceToLong(after).greaterThan(watermark))throw new DomainError('INVALID_INPUT','Invalid inbox cursor.',400);
      const rows=await this.db.collection<InboxEvent>('inboxEvents').find({userId:principal.user._id,sequence:{$gt:sequenceToLong(after),$lte:watermark}},{session}).sort({sequence:1}).limit(limit+1).toArray();
      const page=rows.slice(0,limit);
      return {events:page.map(row=>({eventId:row._id,conversationId:row.conversationId,sequence:longToSequence(row.sequence),kind:row.kind})),nextCursor:rows.length>limit?longToSequence(page.at(-1)!.sequence):longToSequence(watermark),watermark:longToSequence(watermark),hasMore:rows.length>limit};
    });
  }
  async detail(token:string|undefined,id:string):Promise<Conversation>{
    return this.run(async session=>{
      const ctx=await this.authorize(token,id,session);
      const rows=await this.members().find({conversationId:id,$or:[{state:'active'},{state:'invited',invitationExpiresAt:{$gt:new Date()}}]},{session}).sort({createdAt:1,_id:1}).limit(ctx.conversation.kind==='direct'?2:this.auth.config.MAX_GROUP_MEMBERS).toArray();
      const users=await this.db.collection<UserRecord>('users').find({_id:{$in:rows.map(row=>row.userId)}},{session}).toArray();const byId=new Map(users.map(user=>[user._id,user]));
      const otherId=ctx.conversation.directPair?.split(':').find(userId=>userId!==ctx.principal.user._id)??null;
      const pair=otherId?await this.guardPair(ctx.principal.user._id,otherId,session,true):null;
      return {id,kind:ctx.conversation.kind,title:otherId?byId.get(otherId)?.displayName??'Unavailable account':ctx.conversation.title,role:ctx.membership.role,otherUserId:otherId,
        blocked:!!pair?.blockedBy.length,watermark:longToSequence(ctx.conversation.nextEventSeq),members:rows.flatMap(row=>{const user=byId.get(row.userId);return user?[{user:publicUser(user),role:row.role,state:row.state as 'active'|'invited',invitationExpiresAt:row.invitationExpiresAt?.toISOString()??null}]:[];})};
    });
  }
  async history(token:string|undefined,id:string,before:string|undefined,through:string|undefined,limit:number){
    limit=Math.min(limit,this.auth.config.MAX_HISTORY_PAGE);
    return this.run(async session=>{
      const ctx=await this.authorize(token,id,session),watermark=through?sequenceToLong(through):ctx.conversation.nextEventSeq;
      if(watermark.greaterThan(ctx.conversation.nextEventSeq))throw new DomainError('INVALID_INPUT','Invalid history watermark.',400);
      const match={conversationId:id,creationSeq:{$lte:watermark,...(before?{$lt:sequenceToLong(before)}:{})}};
      const rows=await this.db.collection<MessageRecord>('messages').aggregate<MessageRecord>([
        {$match:match},{$sort:{creationSeq:-1}},
        {$lookup:{from:'visibilityIntervals',let:{seq:'$creationSeq'},pipeline:[{$match:{conversationId:id,userId:ctx.principal.user._id,$expr:{$and:[{$lte:['$startSeq','$$seq']},{$or:[{$eq:['$endSeq',null]},{$gt:['$endSeq','$$seq']}]}]}}},{$limit:1}],as:'_visible'}},
        {$match:{'_visible.0':{$exists:true}}},{$limit:limit+1},{$project:{_visible:0}}
      ],{session,maxTimeMS:3000}).toArray();
      const page=rows.slice(0,limit),attachments=await messageAttachments(this.db,page,session);
      return {messages:page.map(row=>({id:row._id,senderId:row.senderId,creationSequence:longToSequence(row.creationSeq),attachments:attachments.get(row._id)??[],text:row.deletedAt?'':row.text,replyToId:row.replyToId??null,deleted:!!row.deletedAt,createdAt:row.createdAt.toISOString()})),nextCursor:rows.length>limit?longToSequence(page.at(-1)!.creationSeq):null,watermark:longToSequence(watermark)};
    });
  }
  async expireInvitationsOnce():Promise<number>{
    if(!await this.db.collection<{_id:string}>('schemaMigrations').findOne({_id:'002_conversations'}))return 0;
    const rows=await this.members().find({state:'invited',invitationExpiresAt:{$lte:new Date()}}).sort({invitationExpiresAt:1}).limit(20).toArray();let expired=0;
    for(const row of rows)expired+=await this.run(async session=>{
      const conversation=await this.conversations().findOneAndUpdate({_id:row.conversationId,state:'active'},{$inc:{guardVersion:1}},{session,returnDocument:'after'});if(!conversation)return 0;
      const member=await this.members().findOneAndUpdate({_id:row._id,state:'invited',invitationExpiresAt:{$lte:new Date()}},{$set:{state:'removed',invitationExpiresAt:null,updatedAt:new Date()},$inc:{guardVersion:1}},{session,returnDocument:'after'});if(!member)return 0;
      await this.event(row.conversationId,'system','member.invitation_expired',{targetUserId:row.userId},session,[row.userId]);return 1;
    });
    return expired;
  }
}
