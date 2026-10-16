export type ErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'INVALID_INPUT' | 'CONFLICT' | 'CURSOR_EXPIRED' | 'RATE_LIMITED' | 'UNAVAILABLE';
export class DomainError extends Error {
  constructor(public readonly code: ErrorCode, message: string, public readonly status: number, public readonly retryable = false) { super(message); }
}
export const unauthorized = () => new DomainError('UNAUTHENTICATED', 'Sign in to continue.', 401);
export const unavailable = () => new DomainError('UNAVAILABLE', 'The service is temporarily unavailable.', 503, true);
