import { expect, it } from 'vitest';
import { brokerOpenFailure } from './broker.js';
it('retains safe broker failure stages/codes without the original endpoint, password or topology', () => {
  const secret = 'private-password-and-queue-identifier';
  for (const [code, message, reason] of [
    ['ECONNREFUSED', `amqp://user:${secret}@private-host/vhost`, 'connection_refused'],
    ['ETIMEDOUT', secret, 'timeout'],
    [403, secret, 'access_refused'],
    [406, secret, 'precondition_failed'],
    [undefined, `Handshake terminated by server: 403 (ACCESS-REFUSED) ${secret}`, 'access_refused'],
    [undefined, `Socket closed abruptly during opening handshake ${secret}`, 'connection_closed'],
    [undefined, secret, 'unavailable'],
  ] as const) {
    const error = brokerOpenFailure({ code, message, endpoint: secret, cause: new Error(secret) }, 'connect');
    expect(error.diagnostic).toMatchObject({ stage: 'connect', reason });
    expect(String(error.stack) + JSON.stringify(error)).not.toContain(secret); expect(error.cause).toBeUndefined();
  }
});
