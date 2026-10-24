import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { attachmentActionSchema, attachmentQuerySchema, idSchema } from '@chat/contracts';
import { DomainError } from '@chat/domain';
import type { AttachmentService } from '@chat/domain';
import { sessionCookieName } from './auth.js';
export const ATTACHMENTS = 'ATTACHMENT_SERVICE';
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw); if (!result.success) throw new DomainError('INVALID_INPUT', 'Check the file request fields.', 400); return result.data;
}
@Controller('/attachments')
export class AttachmentController {
  constructor(@Inject(ATTACHMENTS) private readonly service: AttachmentService) {}
  private token(request: FastifyRequest) { return request.cookies[sessionCookieName(this.service.auth.config.COOKIE_SECURE)]; }
  @Post() @HttpCode(200) reserve(@Req() request: FastifyRequest, @Body() body: unknown) { return this.service.reserve(this.token(request), body); }
  @Get() list(@Req() request: FastifyRequest, @Query() query: unknown) { return this.service.list(this.token(request), parse(attachmentQuerySchema, query).conversationId); }
  @Post('/:id/finalize') @HttpCode(200) finalize(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) { return this.service.finalize(this.token(request), parse(idSchema, id), parse(attachmentActionSchema, body).commandId); }
  @Post('/:id/retry') @HttpCode(200) retry(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) { return this.service.retry(this.token(request), parse(idSchema, id), parse(attachmentActionSchema, body).commandId); }
  @Post('/:id/delete') @HttpCode(200) remove(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) { return this.service.removeFile(this.token(request), parse(idSchema, id), parse(attachmentActionSchema, body).commandId); }
  @Post('/:id/download') @HttpCode(200) download(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) { parse(z.strictObject({}), body); return this.service.download(this.token(request), parse(idSchema, id)); }
  @Post('/:id/preview') @HttpCode(200) preview(@Req() request: FastifyRequest, @Param('id') id: string, @Body() body: unknown) { parse(z.strictObject({}), body); return this.service.download(this.token(request), parse(idSchema, id), true); }
}
