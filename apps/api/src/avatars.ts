import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { idSchema, attachmentActionSchema } from '@chat/contracts';
import { DomainError } from '@chat/domain';
import type { AvatarService } from '@chat/domain';
import { sessionCookieName } from './auth.js';
export const AVATARS = 'AVATAR_SERVICE';
const id = (value: unknown) => { const result = idSchema.safeParse(value); if (!result.success) throw new DomainError('INVALID_INPUT', 'Check the avatar ID.', 400); return result.data; };
const command = (body: unknown) => { const result = attachmentActionSchema.safeParse(body); if (!result.success) throw new DomainError('INVALID_INPUT', 'Check the avatar action.', 400); return result.data.commandId; };
@Controller('/avatars')
export class AvatarController {
  constructor(@Inject(AVATARS) private readonly service: AvatarService) {}
  private token(request: FastifyRequest) { return request.cookies[sessionCookieName(this.service.auth.config.COOKIE_SECURE)]; }
  @Get() profile(@Req() request: FastifyRequest) { return this.service.profile(this.token(request)); }
  @Post() @HttpCode(200) reserve(@Req() request: FastifyRequest, @Body() body: unknown) { return this.service.reserve(this.token(request), body); }
  @Post('/publish') @HttpCode(200) publish(@Req() request: FastifyRequest, @Body() body: unknown) { return this.service.publish(this.token(request), body); }
  @Post('/remove') @HttpCode(200) remove(@Req() request: FastifyRequest, @Body() body: unknown) { return this.service.removeAvatar(this.token(request), body); }
  @Post('/privacy') @HttpCode(200) privacy(@Req() request: FastifyRequest, @Body() body: unknown) { return this.service.visibility(this.token(request), body); }
  @Post('/:id/finalize') @HttpCode(200) finalize(@Req() request: FastifyRequest, @Param('id') value: string, @Body() body: unknown) { return this.service.finalize(this.token(request), id(value), command(body)); }
  @Post('/:id/retry') @HttpCode(200) retry(@Req() request: FastifyRequest, @Param('id') value: string, @Body() body: unknown) { return this.service.retry(this.token(request), id(value), command(body)); }
  @Post('/:userId/download') @HttpCode(200) download(@Req() request: FastifyRequest, @Param('userId') userId: string, @Body() body: unknown) { return this.service.downloadAvatar(this.token(request), id(userId), body); }
}
