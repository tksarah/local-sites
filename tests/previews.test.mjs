import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { Previews, normalizePreview } from '../dist/previews.js';
import { Manager } from '../dist/manager.js';
import { configuration } from '../dist/config.js';
import { createApp } from '../dist/server.js';
import { digest } from '../dist/security.js';

const png = () => sharp({ create: { width: 100, height: 200, channels: 3, background: '#ff0000' } }).png().toBuffer();
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t, capture = png) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'previews-'));
  const calls = [], manager = new Manager(configuration({ DATA_DIR: root, SITE_IP: '127.0.0.1' }), { run: async args => {
    calls.push(args);
    if (args[0] === 'inspect') { const id = args[1].replace('local-sites-', ''); return JSON.stringify([{ Config: { Labels: { 'local-sites.app': id } }, State: { Status: manager.state.apps[id]?.desired === 'running' ? 'running' : 'exited' } }]); }
    return 'ok';
  } });
  await manager.init();
  for (const id of ['one', 'two']) manager.state.apps[id] = { id, port: 18000, url: `https://${id}.home.arpa`, desired: 'running' };
  const previews = new Previews(manager, capture); await previews.init(); manager.previews = previews;
  t.after(async () => { await previews.stop(); await rm(root, { recursive: true, force: true }); });
  return { manager, previews, root, calls };
}

test('image normalization rejects invalid images and fits portrait images without cropping', async () => {
  const result = await normalizePreview(await png()), meta = await sharp(result).metadata();
  assert.equal(meta.format, 'webp'); assert.equal(meta.width, 1280); assert.equal(meta.height, 720);
  const { data } = await sharp(result).raw().toBuffer({ resolveWithObject: true });
  assert.ok(data[0] < 30); // padding, not a stretched red image
  const center = (360 * 1280 + 640) * 3; assert.ok(data[center] > 240);
  await assert.rejects(() => normalizePreview(Buffer.from('not an image')));
  await assert.rejects(() => normalizePreview(Buffer.alloc(5 * 1024 * 1024 + 1)), /5MB/);
  await assert.rejects(() => normalizePreview(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>')), /PNG/);
});

test('initial capture is sequential, listing never captures, and restart restores image and manual mode', async t => {
  let active = 0, peak = 0, count = 0;
  const f = await fixture(t, async () => { count++; peak = Math.max(peak, ++active); const data = await png(); active--; return data; });
  await f.previews.seed(); await f.previews.idle(); assert.equal(peak, 1); assert.equal(count, 2);
  await f.previews.seed(); await f.manager.list(); assert.equal(count, 2);
  assert.equal(f.previews.info('one').state, 'ready');
  await f.previews.upload('one', await png());
  const before = f.previews.info('one'); await f.previews.request('one', false, true); await f.previews.idle(); assert.equal(count, 2);
  const restored = new Previews(f.manager, png); await restored.init(); assert.deepEqual(restored.info('one'), before);
  assert.ok((await restored.image('one')).length);
  await f.previews.request('one', true); await f.previews.idle(); assert.equal(f.previews.info('one').mode, 'auto'); assert.equal(count, 3);
});

test('failed recapture keeps last image; stopped apps reject capture and retain manual images', async t => {
  let fail = false;
  const f = await fixture(t, async () => { if (fail) throw Error('private worker error'); return png(); });
  await f.previews.request('one'); await f.previews.idle(); const url = f.previews.info('one').url;
  fail = true; await f.previews.request('one'); await f.previews.idle();
  assert.equal(f.previews.info('one').state, 'failed'); assert.equal(f.previews.info('one').url, url);
  assert.ok(!f.previews.info('one').error.includes('private worker error'));
  await f.manager.setRunning('one', false); await assert.rejects(() => f.previews.request('one'), /起動/);
  await f.previews.upload('one', await png()); assert.equal(f.previews.info('one').mode, 'manual');
});

test('manual upload supersedes an in-flight capture and redeploy invalidates older captures', async t => {
  const entered = deferred(), release = deferred(); let count = 0;
  const f = await fixture(t, async () => { if (++count === 1) { entered.resolve(); await release.promise; } return png(); });
  await f.previews.request('one'); await entered.promise;
  await f.previews.upload('one', await png()); const manual = f.previews.info('one');
  release.resolve(); await f.previews.idle(); assert.deepEqual(f.previews.info('one'), manual);
  await f.previews.request('one', true); await f.previews.idle();
  const version = f.previews.info('one').url;
  await f.previews.request('one', false, true); await f.previews.idle(); assert.notEqual(f.previews.info('one').url, version);
});

test('soft deletion keeps images; purge cancels late capture even after the same ID is recreated', async t => {
  const entered = deferred(), release = deferred(); let count = 0;
  const f = await fixture(t, async () => { if (++count === 2) { entered.resolve(); await release.promise; } return png(); });
  await f.previews.request('one'); await f.previews.idle();
  const old = f.previews.info('one').url;
  await f.manager.deleteApp('one'); assert.equal(f.previews.info('one').url, old); assert.ok(await f.previews.image('one'));
  delete f.manager.state.apps.one.deletedAt; f.manager.state.apps.one.desired = 'running';
  await f.previews.request('one'); await entered.promise;
  await f.manager.deleteApp('one', true, 'one');
  f.manager.state.apps.one = { id: 'one', port: 18000, url: 'https://one.home.arpa', desired: 'running' };
  release.resolve(); await f.previews.idle();
  assert.equal(f.previews.info('one').url, null); assert.equal((await readdir(path.join(f.root, 'previews'))).length, 0);
});

test('restart marks interrupted captures failed and clears unregistered orphan images', async t => {
  const f = await fixture(t); await f.previews.upload('one', await png());
  const file = path.join(f.root, 'previews/one.json'), record = JSON.parse(await readFile(file, 'utf8'));
  record.mode = 'auto'; record.state = 'capturing'; await writeFile(file, JSON.stringify(record));
  await writeFile(path.join(f.root, 'previews/gone.json'), '{}');
  const restored = new Previews(f.manager, png); await restored.init();
  assert.equal(restored.info('one').state, 'failed'); assert.ok(restored.info('one').url);
  assert.ok(!(await readdir(path.join(f.root, 'previews'))).includes('gone.json'));
});

test('preview APIs protect images and mutations with session, CSRF and body limits', async t => {
  const f = await fixture(t);
  await writeFile(f.manager.config.tokenFile, JSON.stringify([{ name: 'test', sha256: digest('preview-test') }]));
  const server = createApp(f.manager.config, f.manager).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  const base = 'http://127.0.0.1:' + server.address().port, endpoint = base + '/api/apps/one/preview';
  const fetchStatus = async (url, init) => { const r = await fetch(url, init); await r.arrayBuffer(); return r.status; };
  assert.equal(await fetchStatus(endpoint + '/image'), 401);
  const login = await fetch(base + '/api/login', { method: 'POST', headers: { Origin: f.manager.config.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ token: 'preview-test' }) });
  const { csrf } = await login.json(), headers = { Cookie: login.headers.get('set-cookie').split(';')[0], Origin: f.manager.config.origin };
  const data = await png();
  assert.equal(await fetchStatus(endpoint + '/upload', { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: data }), 403);
  const uploadHeaders = { ...headers, 'Content-Type': 'image/png', 'X-CSRF-Token': csrf };
  assert.equal(await fetchStatus(endpoint + '/upload', { method: 'POST', headers: uploadHeaders, body: data }), 200);
  assert.equal(await fetchStatus(endpoint + '/upload', { method: 'POST', headers: uploadHeaders, body: Buffer.from('broken') }), 400);
  assert.equal(await fetchStatus(endpoint + '/upload', { method: 'POST', headers: uploadHeaders, body: Buffer.alloc(5 * 1024 * 1024 + 1) }), 413);
  const image = await fetch(endpoint + '/image', { headers }); assert.equal(image.headers.get('content-type'), 'image/webp'); await image.arrayBuffer();
  assert.match(image.headers.get('content-security-policy'), /img-src 'self'/);
  const apps = await (await fetch(base + '/api/apps', { headers })).json(); assert.equal(apps[0].preview.mode, 'manual');
  assert.equal(await fetchStatus(endpoint + '/capture', { method: 'POST', headers: { ...uploadHeaders, Origin: 'https://other.test' } }), 403);
  assert.equal(await fetchStatus(endpoint + '/auto', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}' }), 200);
  await f.previews.idle(); assert.equal(f.previews.info('one').mode, 'auto');
  assert.equal(await fetchStatus(base + '/api/apps/missing/preview/upload', { method: 'POST', headers: uploadHeaders, body: data }), 400);
  await writeFile(f.manager.config.tokenFile, '[]'); assert.equal(await fetchStatus(endpoint + '/image', { headers }), 401);
});

test('Docker capture is isolated, bounded, and explicitly removed after timeout', async t => {
  const f = await fixture(t), calls = [];
  f.manager.docker.run = async (args, timeout, maxOutput) => {
    calls.push({ args, timeout, maxOutput });
    if (args[0] === 'inspect') return JSON.stringify([{ Config: { Labels: { 'local-sites.app': 'one' } }, State: { Status: 'running' } }]);
    if (args[0] === 'run') throw Error('Docker operation timed out');
    return '';
  };
  const previews = new Previews(f.manager); await previews.init(); await previews.request('one'); await previews.idle();
  const run = calls.find(c => c.args[0] === 'run'); assert.equal(run.timeout, 30000); assert.ok(run.maxOutput > 32000);
  assert.ok(run.args.includes('container:local-sites-one')); assert.ok(run.args.includes('--read-only'));
  assert.ok(!run.args.includes('-v')); assert.ok(!run.args.includes('--privileged')); assert.ok(!run.args.includes('host'));
  assert.ok(calls.some(c => c.args[0] === 'rm' && c.args[1] === '-f')); assert.equal(previews.info('one').state, 'failed');
});
