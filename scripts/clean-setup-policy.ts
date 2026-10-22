import { isAbsolute, resolve, sep } from 'node:path';

export const setupServices = ['mongo', 'redis', 'rabbitmq', 'garage', 'mailpit'] as const;
export const setupVolumes = ['mongo-data', 'rabbit-data', 'garage-meta', 'garage-data'] as const;
export const setupLabel = 'commonroom.clean-setup';
export function addSetupScanner(config: ReturnType<typeof setupCompose>, source: { services: Record<string, Record<string, unknown>> }, owner: string, ports: [number, number]) {
  const { project } = setupIdentity(owner), labels = { [setupLabel]: owner }, projectLabels = { ...labels, 'com.docker.compose.project': project };
  if (new Set(ports).size !== 2 || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('Invalid isolated scanner ports');
  const scanner = source.services['clamav'], processor = source.services['image-processor'], proxy = source.services['image-proxy'];
  if (!scanner || typeof scanner['image'] !== 'string' || !/@sha256:[a-f0-9]{64}$/.test(scanner['image']) || !processor || !proxy || !processor['build']) throw new Error('Missing canonical scanner build/pin');
  const services = config.services;
  services['clamav'] = { ...scanner, profiles: undefined, restart: undefined, labels, volumes: ['clamav-data:/var/lib/clamav'], ports: [`127.0.0.1:${ports[0]}:3310`], pids_limit: 256 };
  const build = processor['build'] as Record<string, unknown>, image = `${project}-processor:0.0.0`;
  services['image-processor'] = { ...processor, profiles: undefined, restart: undefined, labels, image, build: { ...build, labels: projectLabels } };
  services['image-proxy'] = { ...proxy, profiles: undefined, restart: undefined, labels, image, ports: [`127.0.0.1:${ports[1]}:3003`] };
  return { ...config, volumes: { ...config.volumes, 'clamav-data': { labels } }, networks: { ...config.networks, scanning: { labels }, processing: { labels, internal: true } } };
}
export function setupIdentity(owner: string) {
  if (!/^[a-f0-9]{32}$/.test(owner)) throw new Error('Invalid setup owner');
  return { project: `commonroom-setup-${owner}`, database: `setup_${owner}` };
}
export function sourcePath(root: string, name: string) {
  if (!name || isAbsolute(name) || name.includes('\\') || name.split('/').some(part => !part || part === '.' || part === '..') ||
    name.split('/').some(part => ['.git', '.cache', '.pnpm-store', 'node_modules', 'dist', '.runtime'].includes(part)) ||
    name.split('/').some(part => part.startsWith('.env') && part !== '.env.example')) throw new Error('Unsafe setup source path');
  const target = resolve(root, name);
  if (!target.startsWith(resolve(root) + sep)) throw new Error('Setup source escapes root');
  return target;
}
export function assertSetupLabels(labels: Record<string, string> | null, owner: string, project: string) {
  if (setupIdentity(owner).project !== project || labels?.[setupLabel] !== owner || labels['com.docker.compose.project'] !== project) throw new Error('Refusing foreign setup resource');
}
export function setupCompose(source: { services: Record<string, Record<string, unknown>> }, owner: string, ports: number[], garageConfig: string) {
  setupIdentity(owner);
  if (ports.length !== 7 || new Set(ports).size !== 7 || ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) throw new Error('Invalid isolated setup ports');
  const targets = [[27017], [6379], [5672, 15672], [3900], [1025, 8025]];
  const memory = [768, 128, 384, 128, 64]; let index = 0;
  const labels = { [setupLabel]: owner }, services: Record<string, unknown> = {};
  for (const [position, name] of setupServices.entries()) {
    const original = source.services[name];
    if (!original || typeof original['image'] !== 'string' || !/@sha256:[a-f0-9]{64}$/.test(original['image'])) throw new Error('Missing pinned setup image');
    const { image, command, environment, healthcheck } = original;
    services[name] = { image, ...(command ? { command } : {}), ...(environment ? { environment } : {}), healthcheck, labels,
      mem_limit: `${memory[position]}m`, cpus: name === 'mongo' || name === 'rabbitmq' ? 1 : .25, pids_limit: 256,
      ports: targets[position]!.map(target => ({ target, published: String(ports[index++]), host_ip: '127.0.0.1', protocol: 'tcp' })),
      ...(name === 'mongo' ? { volumes: ['mongo-data:/data/db'] } : name === 'rabbitmq' ? { volumes: ['rabbit-data:/var/lib/rabbitmq'] } :
        name === 'garage' ? { volumes: [{ type: 'bind', source: garageConfig, target: '/etc/garage.toml', read_only: true }, 'garage-meta:/var/lib/garage/meta', 'garage-data:/var/lib/garage/data'] } : {}) };
  }
  return { services, volumes: Object.fromEntries(setupVolumes.map(name => [name, { labels }])), networks: { default: { labels } } };
}
