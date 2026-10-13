import { Long } from 'mongodb';
import { sequenceSchema } from '@chat/contracts';
export function sequenceToLong(value: string): Long {
  return Long.fromString(sequenceSchema.parse(value), false);
}
export function longToSequence(value: Long): string {
  if (!Long.isLong(value)) throw new Error('Expected BSON Long');
  return sequenceSchema.parse(value.toString());
}
