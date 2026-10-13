import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
const forbidden = /(?:@chat\/(?:domain|config|observability)|livekit-server-sdk|mongodb|node:)/;
async function inspect(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await inspect(path);
    else if (/\.(ts|tsx)$/.test(entry.name)) {
      const source = await readFile(path, 'utf8');
      for (const match of source.matchAll(/(?:from\s*|import\s*\()?['"]([^'"]+)['"]/g)) {
        if (forbidden.test(match[1] ?? '')) throw new Error(`Server-only import in browser-safe source: ${path}`);
      }
    }
  }
}
await inspect('apps/web/src');
await inspect('packages/contracts/src');
console.log('Browser import boundaries passed');
