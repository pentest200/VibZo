import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
// Input: official https://www.unicode.org/Public/17.0.0/emoji/emoji-test.txt.
// Unicode License V3 is distributed alongside the derived catalogue.
const input = process.argv[2]; if (!input) throw new Error('Pass the pinned Unicode 17.0 emoji-test.txt path');
const raw = await readFile(input, 'utf8'); if (!raw.includes('# Version: 17.0')) throw new Error('Expected Unicode Emoji 17.0');
const rows = []; let group = '';
for (const line of raw.split(/\r?\n/)) {
  if (line.startsWith('# group: ')) group = line.slice(9);
  const match = /^([\dA-F ]+);\s*(fully-qualified|component)\s*#\s*\S+\s+E[\d.]+\s+(.+)$/.exec(line);
  if (!match) continue;
  const emoji = String.fromCodePoint(...match[1].trim().split(/\s+/).map(hex => parseInt(hex, 16)));
  rows.push([emoji, match[3], group]);
}
if (rows.length < 3900 || new Set(rows.map(row => row[0])).size !== rows.length) throw new Error('Incomplete or duplicate catalogue');
await writeFile('apps/web/src/emoji/catalogue.json', JSON.stringify(rows) + '\n');
console.log(`Generated ${rows.length} qualified emoji/components from Unicode 17.0`);
