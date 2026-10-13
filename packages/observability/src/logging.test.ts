import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { createLogger } from './index.js';
it('redacts credentials and private content in structured fields', () => {
  let output = '';
  const sink = new Writable({ write(chunk, _encoding, callback) { output += chunk.toString(); callback(); } });
  createLogger('test', 'info', sink).info({ password: 'secret-pass', req: { headers: { cookie: 'private-cookie' } }, body: { text: 'private-text' }, attachment: { url: 'private-link' } }, 'command rejected');
  for (const secret of ['secret-pass', 'private-cookie', 'private-text', 'private-link']) expect(output).not.toContain(secret);
  expect(output).toContain('[REDACTED]');
});
