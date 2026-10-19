import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import process from 'node:process';
// Windows has no POSIX SIGTERM delivery. Test-only IPC invokes the real registered
// signal handler. Linux sends actual SIGTERM. Never expose this seam in the app.
process.on('message', message => { if (message === 'test:terminate') process.emit('SIGTERM'); });
process.channel?.unref();
const role = process.argv[2];
if (!['api', 'gateway', 'worker'].includes(role ?? '')) throw new Error('Unknown test process');
await import(pathToFileURL(resolve(`apps/${role}/dist/main.js`)).href);
