import type { Db, Document } from 'mongodb';
const str = {bsonType:'string'}, date = {bsonType:'date'}, long = {bsonType:'long',minimum:0};
const num = {bsonType:['int','double'],minimum:0};
const maybeDate = {bsonType:['date','null']}, maybeStr = {bsonType:['string','null']};
const base = {_id:str,schemaVersion:{enum:[1]},createdAt:date};
const shapes: Record<string,Document> = {
  conversations: {kind:{enum:['direct','group']},title:{bsonType:'string',maxLength:80},directPair:maybeStr,state:{enum:['active','archived']},nextEventSeq:long,guardVersion:num,updatedAt:date},
  memberships: {conversationId:str,userId:str,role:{enum:['owner','admin','member']},state:{enum:['active','invited','removed','left']},guardVersion:num,inviterId:maybeStr,invitationExpiresAt:maybeDate,updatedAt:date},
  visibilityIntervals: {conversationId:str,userId:str,startSeq:long,endSeq:{bsonType:['long','null']}},
  pairGuards: {userIds:{bsonType:'array',items:str,minItems:2,maxItems:2,uniqueItems:true},blockedBy:{bsonType:'array',items:str,maxItems:2,uniqueItems:true},guardVersion:num},
  blocks: {blockerId:str,blockedId:str},
  inboxCounters: {sequence:long,guardVersion:num},
  inboxEvents: {userId:str,sequence:long,conversationId:maybeStr,kind:{enum:['conversation.changed','blocks.changed']}},
  conversationEvents: {conversationId:str,sequence:long,actorId:str,kind:str,payload:{bsonType:'object'}},
  outbox: {eventId:str,topic:str,status:{enum:['pending','claimed','published']},availableAt:date,leaseUntil:date,leaseOwner:maybeStr,attempts:num,publishedAt:maybeDate},
  messages: {conversationId:str,senderId:str,clientMessageId:str,originalDigest:str,creationSeq:long,text:{bsonType:'string',maxLength:8000},deletedAt:maybeDate},
  conversationCommands: {userId:str,clientCommandId:str,digest:str,conversationId:str}
};
export async function conversationSchemaReady(db:Db):Promise<boolean> {
  return !!await db.collection<{_id:string}>('schemaMigrations').findOne({_id:'002_conversations'});
}
export async function migrateConversations(db:Db, assertLease:()=>Promise<void>):Promise<void> {
  if(await conversationSchemaReady(db)) return;
  for(const [name,fields] of Object.entries(shapes)) {
    await assertLease();
    const validator={$jsonSchema:{bsonType:'object',required:Object.keys({...base,...fields}),additionalProperties:false,properties:{...base,...fields}}};
    try { await db.createCollection(name,{validator,validationLevel:'strict',validationAction:'error'}); }
    catch(error) { if((error as {code?:number}).code!==48)throw error; await db.command({collMod:name,validator,validationLevel:'strict',validationAction:'error'}); }
  }
  await assertLease();
  await db.collection('conversations').createIndex({directPair:1},{name:'direct_pair_unique',unique:true,partialFilterExpression:{kind:'direct'}});
  await db.collection('memberships').createIndexes([
    {key:{conversationId:1,userId:1},name:'conversation_member_unique',unique:true},
    {key:{userId:1,state:1,conversationId:1},name:'user_inbox_cursor'},
    {key:{conversationId:1,state:1,invitationExpiresAt:1},name:'group_capacity'},
    {key:{state:1,invitationExpiresAt:1},name:'invitation_expiry'}
  ]);
  await assertLease();
  await db.collection('visibilityIntervals').createIndexes([
    {key:{conversationId:1,userId:1,startSeq:1},name:'visibility_window_unique',unique:true},
    {key:{conversationId:1,userId:1,endSeq:1},name:'active_visibility_window'}
  ]);
  await db.collection('blocks').createIndexes([
    {key:{blockerId:1,blockedId:1},name:'directional_block_unique',unique:true},
    {key:{blockedId:1,blockerId:1},name:'inbound_block'}
  ]);
  await db.collection('inboxEvents').createIndex({userId:1,sequence:1},{name:'inbox_event_sequence_unique',unique:true});
  await db.collection('conversationEvents').createIndex({conversationId:1,sequence:1},{name:'conversation_event_sequence_unique',unique:true});
  await assertLease();
  await db.collection('outbox').createIndexes([{key:{eventId:1},name:'event_outbox_unique',unique:true},{key:{status:1,availableAt:1,leaseUntil:1},name:'outbox_claim'}]);
  await db.collection('messages').createIndexes([
    {key:{conversationId:1,senderId:1,clientMessageId:1},name:'message_command_unique',unique:true},
    {key:{conversationId:1,creationSeq:-1},name:'message_history_cursor',unique:true}
  ]);
  await db.collection('conversationCommands').createIndex({userId:1,clientCommandId:1},{name:'creation_command_unique',unique:true});
  await assertLease();
  await db.collection<{_id:string;appliedAt:Date}>('schemaMigrations').updateOne({_id:'002_conversations'},{$setOnInsert:{appliedAt:new Date()}},{upsert:true});
}
