import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { MessageService } from '@chat/domain';
import { sessionCookieName } from './auth.js';
export const MESSAGES = 'MESSAGE_SERVICE';
@Controller()
export class MessageController {
  constructor(@Inject(MESSAGES) private readonly service: MessageService) {}
  @Post('/messages') @HttpCode(200)
  send(@Req() request: FastifyRequest, @Body() body: unknown) {
    return this.service.send(request.cookies[sessionCookieName(this.service.auth.config.COOKIE_SECURE)], body);
  }
}
