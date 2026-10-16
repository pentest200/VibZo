import { z } from 'zod';
export const MAX_SEQUENCE = 9223372036854775807n;
export const sequenceSchema = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine(value => /^(0|[1-9][0-9]{0,18})$/.test(value) && BigInt(value) <= MAX_SEQUENCE, 'Sequence exceeds signed 64-bit range');
export type Sequence = z.infer<typeof sequenceSchema>;
export function compareSequences(a: Sequence, b: Sequence): -1 | 0 | 1 {
  const left = BigInt(sequenceSchema.parse(a)); const right = BigInt(sequenceSchema.parse(b));
  return left < right ? -1 : left > right ? 1 : 0;
}
export const idSchema = z.uuid();
