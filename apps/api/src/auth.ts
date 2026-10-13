import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  consumeTokenSchema, loginSchema, passwordChangeSchema, profileUpdateSchema, registerSchema,
  resetConfirmSchema, resetRequestSchema
} from '@chat/contracts';
import { DomainError, GENERIC_AUTH_MESSAGE } from '@chat/domain';
import type { AuthService } from '@chat/domain';

export const AUTH = 'AUTH_SERVICE';
export const sessionCookieName = (secure: boolean) => secure ? '__Host-commonroom_session' : 'commonroom_session';
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new DomainError('INVALID_INPUT', 'Check the fields and try again.', 400);
  return result.data;
}
@Controller()
export class AuthController {
  constructor(@Inject(AUTH) private readonly auth: AuthService) {}
  private token(request: FastifyRequest) { return request.cookies[sessionCookieName(this.auth.config.COOKIE_SECURE)]; }
  private clear(reply: FastifyReply) { reply.clearCookie(sessionCookieName(this.auth.config.COOKIE_SECURE), { path: '/', secure: this.auth.config.COOKIE_SECURE, httpOnly: true, sameSite: 'lax' }); }
  @Post('/auth/register') @HttpCode(202)
  async register(@Body() body: unknown) { await this.auth.register(parse(registerSchema, body)); return { message: GENERIC_AUTH_MESSAGE }; }
  @Post('/auth/login') @HttpCode(200)
  async login(@Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parse(loginSchema, body);
    await this.auth.rates.consume(`login-email:${input.email}`, 10, 900);
    const result = await this.auth.login(input, this.token(request));
    reply.setCookie(sessionCookieName(this.auth.config.COOKIE_SECURE), result.token, {
      path: '/', secure: this.auth.config.COOKIE_SECURE, httpOnly: true, sameSite: 'lax', maxAge: this.auth.config.SESSION_DURATION_HOURS * 3600
    });
    return result.session;
  }
  @Get('/auth/session') current(@Req() request: FastifyRequest) { return this.auth.current(this.token(request)); }
  @Post('/auth/logout') @HttpCode(200)
  async logout(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) { await this.auth.revoke(this.token(request), 'current'); this.clear(reply); return { message: 'Signed out.' }; }
  @Get('/sessions') sessions(@Req() request: FastifyRequest) { return this.auth.listSessions(this.token(request)); }
  @Delete('/sessions/all')
  async revokeAll(@Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) { await this.auth.revoke(this.token(request), 'all'); this.clear(reply); return { message: 'All sessions signed out.' }; }
  @Delete('/sessions/:id')
  async revokeOne(@Param('id') id: string, @Req() request: FastifyRequest) { await this.auth.revoke(this.token(request), parse(z.uuid(), id)); return { message: 'Session signed out.' }; }
  @Get('/me') async profile(@Req() request: FastifyRequest) { return (await this.auth.current(this.token(request))).user; }
  @Patch('/me') updateProfile(@Body() body: unknown, @Req() request: FastifyRequest) { return this.auth.updateProfile(this.token(request), parse(profileUpdateSchema, body)); }
  @Post('/auth/verify') @HttpCode(200)
  async verify(@Body() body: unknown) { await this.auth.consumeToken(parse(consumeTokenSchema, body).token, 'verify'); return { message: 'Your email is verified.' }; }
  @Post('/auth/verify/request') @HttpCode(202)
  async resend(@Req() request: FastifyRequest) { await this.auth.resendVerification(this.token(request)); return { message: GENERIC_AUTH_MESSAGE }; }
  @Post('/auth/reset/request') @HttpCode(202)
  async requestReset(@Body() body: unknown) {
    const { email } = parse(resetRequestSchema, body); await this.auth.rates.consume(`reset-email:${email}`, 5, 3600);
    await this.auth.requestReset(email); return { message: GENERIC_AUTH_MESSAGE };
  }
  @Post('/auth/reset/confirm') @HttpCode(200)
  async confirmReset(@Body() body: unknown) { const input = parse(resetConfirmSchema, body); await this.auth.consumeToken(input.token, 'reset', input.password); return { message: 'Password reset. Sign in with your new password.' }; }
  @Post('/auth/password') @HttpCode(200)
  async changePassword(@Body() body: unknown, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const input = parse(passwordChangeSchema, body); await this.auth.changePassword(this.token(request), input.currentPassword, input.password);
    this.clear(reply); return { message: 'Password changed. Sign in again.' };
  }
}
