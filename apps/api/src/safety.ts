import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type { z } from 'zod';
import { idSchema, moderationDecisionSchema, notificationPreferenceSchema } from '@chat/contracts';
import { DomainError } from '@chat/domain';
import type { SafetyService } from '@chat/domain';
import { sessionCookieName } from './auth.js';
export const SAFETY = 'SAFETY_SERVICE';
function parse<T>(schema: z.ZodType<T>, raw: unknown): T { const value = schema.safeParse(raw); if (!value.success) throw new DomainError('INVALID_INPUT', 'Check the safety request fields.', 400); return value.data; }
@Controller('/safety')
export class SafetyController {
  constructor(@Inject(SAFETY) private readonly service: SafetyService) {}
  private token(request: FastifyRequest) { return request.cookies[sessionCookieName(this.service.auth.config.COOKIE_SECURE)]; }
  @Get('/notifications') settings(@Req() r: FastifyRequest) { return this.service.settings(this.token(r)); }
  @Patch('/notifications') preference(@Req() r: FastifyRequest, @Body() body: unknown) { return this.service.preference(this.token(r), parse(notificationPreferenceSchema, body).enabled); }
  @Post('/subscriptions') @HttpCode(200) subscribe(@Req() r: FastifyRequest, @Body() body: unknown) { return this.service.subscribe(this.token(r), body); }
  @Delete('/subscriptions') unsubscribe(@Req() r: FastifyRequest) { return this.service.unsubscribe(this.token(r)); }
  @Post('/reports') @HttpCode(200) report(@Req() r: FastifyRequest, @Body() body: unknown) { return this.service.report(this.token(r), body); }
  @Get('/moderation/access') access(@Req() r: FastifyRequest) { return this.service.moderationAccess(this.token(r)); }
  @Get('/moderation/reports') reports(@Req() r: FastifyRequest) { return this.service.reports(this.token(r)); }
  @Post('/moderation/reports/:id') @HttpCode(200) decide(@Req() r: FastifyRequest, @Param('id') id: string, @Body() body: unknown) { return this.service.decide(this.token(r), parse(idSchema, id), parse(moderationDecisionSchema, body).action); }
  @Post('/deletion') @HttpCode(202) async deletion(@Req() r: FastifyRequest, @Body() body: unknown, @Res({ passthrough: true }) reply: FastifyReply) {
    const result = await this.service.requestDeletion(this.token(r), body);
    reply.clearCookie(sessionCookieName(this.service.auth.config.COOKIE_SECURE), { path: '/', secure: this.service.auth.config.COOKIE_SECURE, httpOnly: true, sameSite: 'lax' });
    return result;
  }
}
