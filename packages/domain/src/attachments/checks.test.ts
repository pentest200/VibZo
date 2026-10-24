import { expect, it } from 'vitest';
import { detectFile, FileRejected } from './checks.js';
import { tinyGif, waveTone } from '../../../../tests/fixtures/media.js';

it('recognizes real generated GIF and WAV media without changing their bytes', () => {
  expect(detectFile(tinyGif)).toBe('gif'); expect(detectFile(waveTone())).toBe('wav');
});
it('rejects GIF truncation and data outside the terminated container', () => {
  for (const bytes of [tinyGif.subarray(0, -1), Buffer.concat([tinyGif, Buffer.from('payload')]), Buffer.concat([tinyGif.subarray(0, -1), Buffer.from('payload'), Buffer.from([0x3b])])]) expect(() => detectFile(bytes)).toThrow(FileRejected);
});
it('rejects excessive GIF dimensions and total animation work', () => {
  const huge = Buffer.from(tinyGif); huge.writeUInt16LE(65535, 6); expect(() => detectFile(huge)).toThrow(FileRejected);
  const image = tinyGif.indexOf(0x2c), many = Buffer.concat([tinyGif.subarray(0, image), ...Array.from({ length: 501 }, () => tinyGif.subarray(image, -1)), Buffer.from([0x3b])]); expect(() => detectFile(many)).toThrow(FileRejected);
});
it('preserves a valid multi-frame GIF container for native animated playback', () => {
  const image = tinyGif.indexOf(0x2c), animated = Buffer.concat([tinyGif.subarray(0, image), tinyGif.subarray(image, -1), tinyGif.subarray(image, -1), Buffer.from([0x3b])]); expect(detectFile(animated)).toBe('gif');
});
it('rejects invalid MP4 lengths and absent movie data', () => {
  const bytes = Buffer.alloc(40); bytes.writeUInt32BE(24); bytes.write('ftypisom', 4); bytes.writeUInt32BE(4096, 24); expect(() => detectFile(bytes)).toThrow(FileRejected);
});
