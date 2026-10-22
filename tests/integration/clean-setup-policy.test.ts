import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { addSetupScanner, assertSetupLabels, setupCompose, setupIdentity, setupLabel, setupServices, sourcePath } from '../../scripts/clean-setup-policy.js';
import { browserEndpoints } from '../e2e/endpoints.js';
const owner = 'a'.repeat(32), project = setupIdentity(owner).project;
it('allows distinct browser ports only for an isolated test setup and retains ordinary defaults', () => {
  expect(browserEndpoints({})).toEqual({ api: 3000, gateway: 3001, worker: 3002, web: 5173, origin: 'http://localhost:5173' });
  const env = { NODE_ENV: 'test', SETUP_REHEARSAL_OWNER: owner, E2E_SETUP_PORTS: '13000,13001,13002,15173' };
  expect(browserEndpoints(env).origin).toBe('http://localhost:15173');
  for (const value of [{ ...env, NODE_ENV: 'production' }, { ...env, SETUP_REHEARSAL_OWNER: '' }, { ...env, E2E_SETUP_PORTS: '1,2,3,4' }, { ...env, E2E_SETUP_PORTS: '13000,13000,13002,15173' }]) expect(() => browserEndpoints(value)).toThrow();
});
it('rejects traversal, ignored trees, secret files and foreign cleanup ownership', () => {
  for (const name of ['../escape', '/absolute', 'C:\\outside', 'a/../../b', '.git/config', '.cache/token', 'node_modules/pkg/index.js', '.env', 'a/.env.local', 'a//b']) expect(() => sourcePath(resolve('.'), name)).toThrow();
  expect(sourcePath(resolve('.'), '.env.example')).toBe(resolve('.env.example'));
  expect(() => setupIdentity('../foreign')).toThrow();
  for (const labels of [null, {}, { [setupLabel]: owner }, { [setupLabel]: owner, 'com.docker.compose.project': 'commonroom-local' }]) expect(() => assertSetupLabels(labels, owner, project)).toThrow();
  expect(() => assertSetupLabels({ [setupLabel]: owner, 'com.docker.compose.project': project }, owner, project)).not.toThrow();
});
it('uses only pinned baseline services with new labelled volumes and unique loopback ports', () => {
  const source = { services: Object.fromEntries(setupServices.map(name => [name, { image: `example:${name}@sha256:${'b'.repeat(64)}`, ports: ['0.0.0.0:1:1'], volumes: ['ordinary:/data'], restart: 'always' }])) };
  const original = JSON.stringify(source), ports = [27018, 6380, 5673, 15673, 3904, 1026, 8026];
  const config = setupCompose(source, owner, ports, resolve('infra/compose/garage.toml'));
  expect(JSON.stringify(source)).toBe(original);
  expect(Object.keys(config.services)).toEqual([...setupServices]);
  const services = Object.values(config.services) as { ports: { host_ip: string; published: string }[]; restart?: unknown; labels: Record<string, string>; mem_limit: string }[];
  expect(services.flatMap(service => service.ports).map(port => port.published)).toEqual(ports.map(String));
  expect(services.every(service => service.ports.every(port => port.host_ip === '127.0.0.1') && service.labels[setupLabel] === owner && !service.restart)).toBe(true);
  expect(services.reduce((sum, service) => sum + Number.parseInt(service.mem_limit), 0)).toBe(1472);
  expect(JSON.stringify(config)).not.toContain('ordinary:');
  expect(() => setupCompose(source, owner, [1234], 'config')).toThrow();
  source.services.mongo!.image = 'mongo:latest'; expect(() => setupCompose(source, owner, ports, 'config')).toThrow();
});
it('adds a separately owned scanner volume/build and internal decoder network without borrowing ordinary storage', () => {
  const source = { services: Object.fromEntries([...setupServices, 'clamav', 'image-processor', 'image-proxy'].map(name => [name, { image: `example:${name}@sha256:${'b'.repeat(64)}`, build: { context: '/owned/source/processor' }, profiles: ['scanner'], volumes: ['ordinary:/data'], networks: name === 'image-processor' ? ['processing'] : ['scanning'] }])) };
  const config = addSetupScanner(setupCompose(source, owner, [27018, 6380, 5673, 15673, 3904, 1026, 8026], 'config'), source, owner, [13310, 13003]);
  expect(config.volumes['clamav-data'].labels[setupLabel]).toBe(owner);
  expect(config.networks.processing.internal).toBe(true);
  const scanner = config.services['clamav'] as { volumes: string[]; ports: string[] };
  expect(scanner.volumes).toEqual(['clamav-data:/var/lib/clamav']); expect(scanner.ports).toEqual(['127.0.0.1:13310:3310']);
  const processor = config.services['image-processor'] as { image: string; build: { labels: Record<string, string> } };
  expect(processor.image).toBe(`${project}-processor:0.0.0`); expect(processor.build.labels[setupLabel]).toBe(owner);
  expect(() => addSetupScanner(config, source, owner, [13310, 13310])).toThrow();
});
