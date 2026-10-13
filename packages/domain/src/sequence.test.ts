import { expect, it } from 'vitest';
import { Long, BSON } from 'mongodb';
import { longToSequence, sequenceToLong } from './sequence.js';
it('round-trips exact BSON Long above JS safe integer', () => {
  const wire = '9223372036854775807';
  const document = BSON.deserialize(BSON.serialize({ sequence: sequenceToLong(wire) }), { promoteLongs: false });
  expect(longToSequence(document['sequence'] as Long)).toBe(wire);
  expect(() => longToSequence(Long.fromNumber(-1))).toThrow();
});
