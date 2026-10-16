import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Put, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { blocksQuerySchema, directCreateSchema, feedQuerySchema, groupCreateSchema, historyQuerySchema, inboxQuerySchema, inviteSchema, roleSchema, searchQuerySchema, titleSchema, transferSchema } from '@chat/contracts';
import { DomainError } from '@chat/domain';
import type { ConversationService } from '@chat/domain';
import { sessionCookieName } from './auth.js';
export const CONVERSATIONS='CONVERSATION_SERVICE';
function parse<T>(schema:z.ZodType<T>,value:unknown):T{const result=schema.safeParse(value);if(!result.success)throw new DomainError('INVALID_INPUT','Check the request fields and cursor.',400);return result.data;}
const ok=()=>({message:'Saved.'});
@Controller()
export class ConversationController {
  constructor(@Inject(CONVERSATIONS)private readonly service:ConversationService){}
  private token(request:FastifyRequest){return request.cookies[sessionCookieName(this.service.auth.config.COOKIE_SECURE)];}
  private id(value:string){return parse(z.uuid(),value);}
  @Get('/users')search(@Req()request:FastifyRequest,@Query()query:unknown){const input=parse(searchQuerySchema,query);return this.service.search(this.token(request),input.prefix,input.after,input.limit);}
  @Post('/conversations/direct')@HttpCode(200)direct(@Req()request:FastifyRequest,@Body()body:unknown){return this.service.createDirect(this.token(request),parse(directCreateSchema,body).targetUserId);}
  @Post('/conversations/groups')@HttpCode(200)group(@Req()request:FastifyRequest,@Body()body:unknown){const input=parse(groupCreateSchema,body);return this.service.createGroup(this.token(request),input.clientCommandId,input.title);}
  @Get('/inbox/snapshot')inbox(@Req()request:FastifyRequest,@Query()query:unknown){const input=parse(inboxQuerySchema,query);return this.service.inbox(this.token(request),input.after,input.limit);}
  @Get('/inbox/events')feed(@Req()request:FastifyRequest,@Query()query:unknown){const input=parse(feedQuerySchema,query);return this.service.inboxFeed(this.token(request),input.after,input.through,input.limit);}
  @Get('/conversations/:id')detail(@Req()request:FastifyRequest,@Param('id')id:string){return this.service.detail(this.token(request),this.id(id));}
  @Get('/conversations/:id/messages')history(@Req()request:FastifyRequest,@Param('id')id:string,@Query()query:unknown){const input=parse(historyQuerySchema,query);return this.service.history(this.token(request),this.id(id),input.before,input.through,input.limit);}
  @Post('/conversations/:id/invitations')@HttpCode(200)async invite(@Req()request:FastifyRequest,@Param('id')id:string,@Body()body:unknown){await this.service.invite(this.token(request),this.id(id),parse(inviteSchema,body).targetUserId);return ok();}
  @Post('/conversations/:id/accept')@HttpCode(200)async accept(@Req()request:FastifyRequest,@Param('id')id:string){await this.service.respondInvitation(this.token(request),this.id(id),true);return ok();}
  @Post('/conversations/:id/decline')@HttpCode(200)async decline(@Req()request:FastifyRequest,@Param('id')id:string){await this.service.respondInvitation(this.token(request),this.id(id),false);return ok();}
  @Post('/conversations/:id/leave')@HttpCode(200)async leave(@Req()request:FastifyRequest,@Param('id')id:string){await this.service.remove(this.token(request),this.id(id),undefined);return ok();}
  @Delete('/conversations/:id/members/:userId')async remove(@Req()request:FastifyRequest,@Param('id')id:string,@Param('userId')userId:string){await this.service.remove(this.token(request),this.id(id),this.id(userId));return ok();}
  @Patch('/conversations/:id/members/:userId')async role(@Req()request:FastifyRequest,@Param('id')id:string,@Param('userId')userId:string,@Body()body:unknown){await this.service.changeRole(this.token(request),this.id(id),this.id(userId),parse(roleSchema,body).role);return ok();}
  @Post('/conversations/:id/owner')@HttpCode(200)async transfer(@Req()request:FastifyRequest,@Param('id')id:string,@Body()body:unknown){await this.service.transferOwner(this.token(request),this.id(id),parse(transferSchema,body).targetUserId);return ok();}
  @Patch('/conversations/:id')async rename(@Req()request:FastifyRequest,@Param('id')id:string,@Body()body:unknown){await this.service.rename(this.token(request),this.id(id),parse(titleSchema,body).title);return ok();}
  @Get('/blocks')blocks(@Req()request:FastifyRequest,@Query()query:unknown){const input=parse(blocksQuerySchema,query);return this.service.listBlocks(this.token(request),input.after,input.limit);}
  @Put('/blocks/:userId')async block(@Req()request:FastifyRequest,@Param('userId')id:string){await this.service.setBlock(this.token(request),this.id(id),true);return ok();}
  @Delete('/blocks/:userId')async unblock(@Req()request:FastifyRequest,@Param('userId')id:string){await this.service.setBlock(this.token(request),this.id(id),false);return ok();}
}
