import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';
import { idSchema, historyWindowQuerySchema, replayQuerySchema, snapshotCreateSchema, snapshotPageQuerySchema } from '@chat/contracts';
import { DomainError } from '@chat/domain';
import type { SyncService } from '@chat/domain';
import { sessionCookieName } from './auth.js';
export const SYNC = 'SYNC_SERVICE';
function parse<T>(schema: z.ZodType<T>, raw: unknown): T { const result = schema.safeParse(raw); if (!result.success) throw new DomainError('INVALID_INPUT', 'Check the sync request fields.', 400); return result.data; }
@Controller('/sync')
export class SyncController {
  constructor(@Inject(SYNC) private readonly service: SyncService) {}
  private token(request: FastifyRequest) { return request.cookies[sessionCookieName(this.service.auth.config.COOKIE_SECURE)]; }
  @Get('/conversations/:id/events') replay(@Req() request: FastifyRequest, @Param('id') id: string, @Query() query: unknown) { const input = parse(replayQuerySchema, query); return this.service.replay(this.token(request), parse(idSchema, id), input.after, input.through, input.limit); }
  @Get('/conversations/:id/snapshot') snapshot(@Req() request: FastifyRequest, @Param('id') id: string, @Query() query: unknown) { return this.service.snapshot(this.token(request), parse(idSchema, id), parse(historyWindowQuerySchema, query).before); }
  @Post('/snapshots') @HttpCode(200) create(@Req() request: FastifyRequest, @Body() body: unknown) { const input = parse(snapshotCreateSchema, body); return this.service.createSnapshot(this.token(request), input.kind, input.conversationId); }
  @Get('/snapshots/:id') page(@Req() request: FastifyRequest, @Param('id') id: string, @Query() query: unknown) { return this.service.snapshotPage(this.token(request), parse(idSchema, id), parse(snapshotPageQuerySchema, query).page); }
  @Delete('/snapshots/:id') async release(@Req() request: FastifyRequest, @Param('id') id: string) { const principal = await this.service.auth.authenticate(this.token(request)); await this.service.db.collection<{ _id: string; userId: string }>('syncSnapshots').deleteOne({ _id: parse(idSchema, id), userId: principal.user._id }); return { message: 'Released.' }; }
  @Post('/mutations') @HttpCode(200) mutate(@Req() request: FastifyRequest, @Body() body: unknown) { return this.service.mutate(this.token(request), body); }
}
