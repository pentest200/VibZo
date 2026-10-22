// Port overrides are reserved for a labelled clean-setup owner. Ordinary browser
// suites keep their existing endpoints, assertions and cleanup interlocks.
export function browserEndpoints(env: NodeJS.ProcessEnv = process.env) {
  const defaults = { api: 3000, gateway: 3001, worker: 3002, web: 5173 };
  if (!env['E2E_SETUP_PORTS']) return { ...defaults, origin: 'http://localhost:5173' };
  if (!/^[a-f0-9]{32}$/.test(env['SETUP_REHEARSAL_OWNER'] ?? '') || env['NODE_ENV'] !== 'test') throw new Error('Browser port overrides require an isolated setup owner');
  const values = env['E2E_SETUP_PORTS'].split(',').map(Number);
  if (values.length !== 4 || new Set(values).size !== 4 || values.some(value => !Number.isInteger(value) || value < 1024 || value > 65535)) throw new Error('Invalid isolated browser ports');
  const [api, gateway, worker, web] = values as [number, number, number, number];
  return { api, gateway, worker, web, origin: `http://localhost:${web}` };
}
