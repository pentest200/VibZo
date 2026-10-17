import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { idSchema } from '@chat/contracts';
import { DomainError } from '@chat/domain';
import type { CallService } from '@chat/domain';
import { sessionCookieName } from './auth.js';
export const CALLS = 'CALL_SERVICE';
function parse<T>(schema: z.ZodType<T>, raw: unknown) { const result = schema.safeParse(raw); if (!result.success) throw new DomainError('INVALID_INPUT', 'Check the call fields.', 400); return result.data; }
@Controller('/calls')
export class CallController {
  constructor(@Inject(CALLS) private readonly service: CallService) {}
  private token(r: FastifyRequest) { return r.cookies[sessionCookieName(this.service.auth.config.COOKIE_SECURE)]; }
  @Get('/status') status(@Req() r: FastifyRequest) { return this.service.status(this.token(r)); }
  @Get('/invitations') invitations(@Req() r: FastifyRequest) { return this.service.invitations(this.token(r)); }
  @Get() list(@Req() r: FastifyRequest, @Query() raw: unknown) { return this.service.list(this.token(r), parse(z.strictObject({ conversationId: idSchema }), raw).conversationId); }
  @Post() @HttpCode(200) start(@Req() r: FastifyRequest, @Body() body: unknown) { return this.service.start(this.token(r), body); }
  @Get('/:id') get(@Req() r: FastifyRequest, @Param('id') id: string) { return this.service.get(this.token(r), parse(idSchema, id)); }
  @Post('/:id/actions') @HttpCode(200) action(@Req() r: FastifyRequest, @Param('id') id: string, @Body() body: unknown) { return this.service.action(this.token(r), parse(idSchema, id), body); }
  @Post('/:id/join') @HttpCode(200) join(@Req() r: FastifyRequest, @Param('id') id: string, @Body() body: unknown) { parse(z.strictObject({}), body); return this.service.join(this.token(r), parse(idSchema, id)); }
}
@Controller('/webhooks')
export class CallWebhookController {
  constructor(@Inject(CALLS) private readonly service: CallService) {}
  @Post('/livekit') @HttpCode(200) webhook(@Req() request: RawBodyRequest<FastifyRequest>, @Body() body: unknown) {
    const raw = Buffer.isBuffer(body) ? body : request.rawBody;
    if (!raw) throw new DomainError('INVALID_INPUT', 'Exact webhook bytes are required.', 400);
    return this.service.webhook(raw, typeof request.headers.authorization === 'string' ? request.headers.authorization : undefined);
  }
}
