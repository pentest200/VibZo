import { authSessionSchema, problemSchema } from '@chat/contracts';
import type { AuthSession } from '@chat/contracts';
export class RequestError extends Error { constructor(message: string, readonly status: number) { super(message); } }
export async function api(path: string, options: { method?: string; body?: unknown; csrf?: string } = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, { method: options.method ?? 'GET', credentials: 'same-origin', signal: AbortSignal.timeout(15000),
      headers: { ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(options.csrf ? { 'X-CSRF-Token': options.csrf } : {}) },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
  } catch { throw new RequestError('Connection interrupted. Refresh to check your account before trying again.', 0); }
  const result: unknown = await response.json();
  if (!response.ok) { const problem = problemSchema.safeParse(result); throw new RequestError(problem.success ? problem.data.message : 'The request could not be completed.', response.status); }
  return result;
}
export async function currentSession(): Promise<AuthSession | null> {
  try { return authSessionSchema.parse(await api('/auth/session')); }
  catch (error) { if (error instanceof RequestError && error.status === 401) return null; throw error; }
}
