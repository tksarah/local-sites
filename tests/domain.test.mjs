import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configuration } from '../dist/config.js';
import { Manager } from '../dist/manager.js';

test('management and named app routes share the same Caddy bind address', async () => {
  const caddy = await readFile(new URL('../deploy/Caddyfile', import.meta.url), 'utf8');
  assert.match(caddy, /https:\/\/\{\$SITE_IP\} \{\s+bind \{\$SITE_IP\}/);
});

test('APP_DOMAIN accepts DNS names and rejects Caddy injection or missing gateway', () => {
  assert.equal(configuration({}).appDomain, '');
  assert.equal(configuration({ APP_DOMAIN: 'Home.Arpa', GATEWAY_CONTAINER: 'gateway' }).appDomain, 'home.arpa');
  for (const domain of ['https://home.arpa', 'home.arpa:443', '*.home.arpa', 'home.arpa\n{', 'a..arpa', '-a.arpa', 'home.arpa.', '192.0.2.1']) {
    assert.throws(() => configuration({ APP_DOMAIN: domain, GATEWAY_CONTAINER: 'gateway' }));
  }
  assert.throws(() => configuration({ APP_DOMAIN: 'home.arpa' }), /GATEWAY_CONTAINER/);
});

test('existing apps and jobs migrate to names, retain IP routes and revert without data changes', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'domain-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const state = { apps: {}, jobs: {}, uploads: {} };
  for (const [id, port] of [['notes', 18000], ['album', 18001]]) {
    state.apps[id] = { id, port, image: 'unchanged', desired: 'running', url: `https://127.0.0.1:${port}` };
    state.jobs[id] = { id, appId: id, status: 'succeeded', url: state.apps[id].url };
  }
  await writeFile(path.join(root, 'state.json'), JSON.stringify(state));
  const calls = [];
  const docker = { run: async args => {
    calls.push(args);
    if (args[0] === 'inspect') throw Error('No such container');
    return '';
  } };
  const config = configuration({ DATA_DIR: root, GATEWAY_CONTAINER: 'gateway', APP_DOMAIN: 'home.arpa' });
  const manager = new Manager(config, docker);
  await manager.init();
  const routes = await readFile(path.join(root, 'gateway/apps.caddy'), 'utf8');
  for (const app of await manager.list()) {
    assert.equal(app.url, `https://${app.id}.home.arpa`);
    assert.equal(manager.job(app.id).url, app.url);
    assert.equal(app.image, 'unchanged');
    assert.ok(routes.includes(`https://127.0.0.1:${app.port}, ${app.url}`));
    assert.ok(routes.includes(`reverse_proxy 127.0.0.1:${app.port}`));
  }
  assert.match(routes, /respond @outside "LAN access only" 403/);
  assert.match(routes, /tls internal/);
  assert.equal(calls.some(args => ['run', 'rm', 'build', 'volume'].includes(args[0])), false);
  const legacy = new Manager({ ...config, appDomain: '' }, docker);
  await legacy.init();
  assert.equal(legacy.state.apps.notes.url, 'https://127.0.0.1:18000');
  assert.doesNotMatch(await readFile(path.join(root, 'gateway/apps.caddy'), 'utf8'), /home\.arpa/);
});
