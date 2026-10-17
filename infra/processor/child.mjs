import sharp from 'sharp';
import process from 'node:process';
import { Buffer } from 'node:buffer';
sharp.cache(false); sharp.concurrency(1);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({ operation: ['VipsForeignLoadJpegBuffer', 'VipsForeignLoadPngBuffer', 'VipsForeignLoadWebpBuffer'] });
try {
  const chunks = []; let size = 0;
  for await (const chunk of process.stdin) { size += chunk.length; if (size > 26214400) throw new Error('Input limit'); chunks.push(chunk); }
  const bytes = Buffer.concat(chunks), options = { limitInputPixels: 8388608, limitInputChannels: 4, failOn: 'warning' };
  const metadata = await sharp(bytes, options).metadata();
  if (metadata.format !== process.argv[2] || (metadata.pages ?? 1) > 1) throw new Error('Unsupported image');
  const output = await sharp(bytes, options).autoOrient().resize({ width: 2048, height: 2048, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82, effort: 4 }).timeout({ seconds: 10 }).toBuffer();
  if (!output.length || output.length > 26214400) throw new Error('Output limit'); process.stdout.write(output);
} catch { process.exitCode = 1; }
