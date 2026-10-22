import { expect, it } from 'vitest';
import { requestFailure } from './request-failure.js';
it('classifies bounded dependency failures without retaining payloads or identities', () => {
  const secret = 'private-cookie-message-sdp';
  const error = { name: 'MongoOperationTimeoutError', message: secret, cause: { code: 112, errorLabels: ['TransientTransactionError', secret], stack: secret } };
  expect(requestFailure(error)).toEqual({ reason: 'mongo_write_conflict', transientTransaction: true, ambiguousCommit: false });
  expect(JSON.stringify(requestFailure(error))).not.toContain(secret);
  expect(requestFailure({ name: 'MongoOperationTimeoutError' }).reason).toBe('mongo_operation_timeout');
  const cycle: { cause?: unknown } = {}; cycle.cause = cycle;
  expect(requestFailure(cycle).reason).toBe('unclassified');
  expect(requestFailure(null).reason).toBe('unclassified');
});
