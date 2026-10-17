import { connect } from 'node:net';
import type { Config } from '@chat/config';
import type { AttachmentKind } from './model.js';
export class FileRejected extends Error {}
export function detectFile(bytes: Buffer): AttachmentKind {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (bytes.subarray(0, 5).toString() === '%PDF-' && bytes.subarray(-1024).toString().includes('%%EOF')) return 'pdf';
  let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new FileRejected('This file type is not allowed.'); }
  let controls = false;
  for (const char of text) { const code = char.codePointAt(0)!; if (code < 32 && ![9, 10, 13].includes(code) || code === 127) { controls = true; break; } }
  if (!text.length || controls || /^\s*(?:<|%PDF-|PK)/i.test(text) || /<(?:!doctype\s+html|\/?(?:html|svg|script|iframe|object|embed|style|link|meta)(?:\s|>|\/))/i.test(text)) throw new FileRejected('This file type is not allowed.');
  return 'text';
}
export async function scanBytes(bytes: Buffer, config: Config): Promise<void> {
  // INSTREAM passes bytes, never a host pathname, to an actual clamd daemon.
  return new Promise<void>((resolve, reject) => {
    const socket = connect({ host: config.CLAMAV_HOST, port: config.CLAMAV_PORT }); let response = Buffer.alloc(0), settled = false;
    const finish = (error?: Error) => { if (settled) return; settled = true; clearTimeout(deadline); clearTimeout(connectDeadline); socket.destroy(); if (error) reject(error); else resolve(); };
    const deadline = setTimeout(() => finish(new Error('Scanner deadline')), config.SCANNER_TIMEOUT_MS);
    const connectDeadline = setTimeout(() => finish(new Error('Scanner connection unavailable')), config.DEPENDENCY_TIMEOUT_MS);
    socket.once('error', () => finish(new Error('Scanner unavailable'))); socket.once('close', () => { if (!settled) finish(new Error('Scanner response interrupted')); });
    socket.on('data', data => { response = Buffer.concat([response, data]); if (response.length > 4096) { finish(new Error('Invalid scanner response')); return; } if (!response.includes(0)) return;
      const result = response.toString(); if (/^stream: OK\0$/.test(result)) finish(); else if (/^stream: .+ FOUND\0$/.test(result)) finish(new FileRejected('This file did not pass the safety scan.')); else finish(new Error('Scanner could not complete checks'));
    });
    const write = (data: Buffer) => new Promise<void>((done, fail) => { socket.write(data, error => error ? fail(error) : done()); });
    socket.once('connect', () => { clearTimeout(connectDeadline); void (async () => {
      await write(Buffer.from('zINSTREAM\0')); for (let offset = 0; offset < bytes.length; offset += 32768) { const chunk = bytes.subarray(offset, offset + 32768), size = Buffer.alloc(4); size.writeUInt32BE(chunk.length); await write(size); await write(chunk); } await write(Buffer.alloc(4));
    })().catch(() => finish(new Error('Scanner stream interrupted'))); });
  });
}
export async function transformImage(bytes: Buffer, kind: string, config: Config) {
  const response = await fetch(`${config.IMAGE_PROCESSOR_URL}/transform/${kind}`, { method: 'POST', headers: { Authorization: `Bearer ${config.IMAGE_PROCESSOR_KEY}`, 'Content-Type': 'application/octet-stream' }, body: Uint8Array.from(bytes), signal: AbortSignal.timeout(25000) });
  if (response.status === 422 || response.status === 413) throw new FileRejected('This image could not be processed safely.'); if (!response.ok || response.headers.get('content-type') !== 'image/webp') throw new Error('Image processor unavailable');
  if (!response.body) throw new Error('Missing transformed image'); const reader = response.body.getReader(), chunks: Buffer[] = []; let length = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; length += next.value.length; if (length > config.MAX_ATTACHMENT_BYTES) throw new FileRejected('The processed image is too large.'); chunks.push(Buffer.from(next.value)); } }
  finally { await reader.cancel().catch(() => {}); }
  if (!length) throw new FileRejected('The processed image is empty.'); return Buffer.concat(chunks);
}
