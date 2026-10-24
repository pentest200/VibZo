import { connect } from 'node:net';
import type { Config } from '@chat/config';
import type { AttachmentKind } from './model.js';
export class FileRejected extends Error {}
function validateGif(bytes: Buffer) {
  const bad = () => { throw new FileRejected('This GIF is incomplete or exceeds safe animation limits.'); };
  if (bytes.length < 14) return bad();
  const width = bytes.readUInt16LE(6), height = bytes.readUInt16LE(8);
  if (!width || !height || width > 8192 || height > 8192 || width * height > 40000000) return bad();
  let offset = 13 + ((bytes[10]! & 0x80) ? 3 * 2 ** ((bytes[10]! & 7) + 1) : 0), frames = 0, pixels = 0;
  const blocks = () => { while (offset < bytes.length) { const size = bytes[offset++]!; if (!size) return; offset += size; if (offset > bytes.length) return bad(); } return bad(); };
  while (offset < bytes.length) {
    const marker = bytes[offset++]!;
    if (marker === 0x3b) { if (offset !== bytes.length || !frames) return bad(); return; }
    if (marker === 0x21) { if (offset >= bytes.length || ![0x01, 0xf9, 0xfe, 0xff].includes(bytes[offset++]!)) return bad(); blocks(); }
    else if (marker === 0x2c) {
      if (offset + 9 > bytes.length) return bad();
      const left = bytes.readUInt16LE(offset), top = bytes.readUInt16LE(offset + 2), w = bytes.readUInt16LE(offset + 4), h = bytes.readUInt16LE(offset + 6), flags = bytes[offset + 8]!;
      frames++; pixels += w * h; if (!w || !h || left + w > width || top + h > height || frames > 500 || pixels > 100000000) return bad();
      offset += 9 + ((flags & 0x80) ? 3 * 2 ** ((flags & 7) + 1) : 0);
      if (offset >= bytes.length || bytes[offset]! < 2 || bytes[offset]! > 8) return bad(); offset++; blocks();
    } else return bad();
  }
  return bad();
}
export function detectFile(bytes: Buffer): AttachmentKind {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'jpeg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (bytes.subarray(0, 5).toString() === '%PDF-' && bytes.subarray(-1024).toString().includes('%%EOF')) return 'pdf';
  // Media stays byte bounded and virus scanned. Decode only in the browser's native media sandbox.
  const header = bytes.subarray(0, 6).toString('ascii');
  if (['GIF87a', 'GIF89a'].includes(header)) { validateGif(bytes); return 'gif'; }
  if (bytes.length > 44 && bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE' && bytes.readUInt32LE(4) + 8 === bytes.length && bytes.includes(Buffer.from('fmt ')) && bytes.includes(Buffer.from('data'))) return 'wav';
  if (bytes.length > 28 && bytes.subarray(0, 4).toString() === 'OggS' && bytes[4] === 0 && (bytes.includes(Buffer.from('OpusHead')) || bytes.includes(Buffer.from('vorbis')))) return 'ogg';
  if (bytes.length > 32 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) && bytes.subarray(0, 256).includes(Buffer.from('webm'))) return 'webm';
  if (bytes.length > 32 && bytes.subarray(4, 8).toString() === 'ftyp' && /^(isom|iso[2-9]|mp4[12]|avc1|M4V |M4A )$/.test(bytes.subarray(8, 12).toString())) {
    let offset = 0, movie = false, data = false;
    while (offset + 8 <= bytes.length) {
      let size = bytes.readUInt32BE(offset); const kind = bytes.subarray(offset + 4, offset + 8).toString();
      if (size === 1) { if (offset + 16 > bytes.length) break; const wide = bytes.readBigUInt64BE(offset + 8); if (wide > BigInt(bytes.length)) break; size = Number(wide); }
      if (size === 0) size = bytes.length - offset;
      if (size < 8 || offset + size > bytes.length) break;
      movie ||= kind === 'moov'; data ||= kind === 'mdat'; offset += size;
    }
    if (offset === bytes.length && movie && data) return 'mp4';
    throw new FileRejected('This MP4 container is incomplete.');
  }
  if (bytes.length > 32) {
    let offset = 0;
    if (bytes.subarray(0, 3).toString() === 'ID3' && bytes[3]! < 5 && bytes.subarray(6, 10).every(byte => byte < 128)) offset = 10 + ((bytes[6]! << 21) | (bytes[7]! << 14) | (bytes[8]! << 7) | bytes[9]!) + ((bytes[5]! & 0x10) ? 10 : 0);
    if (offset + 4 < bytes.length && bytes[offset] === 0xff && (bytes[offset + 1]! & 0xe0) === 0xe0 && (bytes[offset + 1]! & 0x06) !== 0 && (bytes[offset + 2]! & 0xf0) !== 0xf0 && (bytes[offset + 2]! & 0xf0) !== 0 && (bytes[offset + 2]! & 0x0c) !== 0x0c) return 'mp3';
  }
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
