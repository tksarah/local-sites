import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { configuration } from '../dist/config.js';
import { digest, safeArchiveEntry } from '../dist/security.js';
import { Manager } from '../dist/manager.js';
import { createApp } from '../dist/server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-sites-'));
  const config = configuration({ DATA_DIR: root, SITE_IP: '127.0.0.1' });
  const docker = { run: async () => { throw new Error('No such object'); } };
  const manager = new Manager(config, docker); await manager.init();
  await writeFile(config.tokenFile, JSON.stringify([{ name: 'test', sha256: digest('secret') }]));
  const server = createApp(config, manager).listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { await manager.idle(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  return { root, config, manager, url };
}
test('MCP initializes, discovers nine tools, calls list, and enforces revocation', async t => {
  const { url, config } = await fixture(t);
  const client = new Client({ name: 'test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer secret' } } });
  await client.connect(transport); t.after(() => client.close());
  const tools = await client.listTools(); assert.equal(tools.tools.length, 9);
  const result = await client.callTool({ name: 'list_apps', arguments: {} }); assert.equal(result.content[0].text, '[]');
  await writeFile(config.tokenFile, '[]');
  await assert.rejects(() => client.listTools());
});
test('missing authentication and browser cross-origin calls are rejected', async t => {
  const { url } = await fixture(t);
  assert.equal((await fetch(url + '/mcp', { method: 'POST' })).status, 401);
  assert.equal((await fetch(url + '/mcp', { method: 'POST', headers: { Authorization: 'Bearer secret', Origin: 'https://evil.example' } })).status, 403);
});
test('uploaded archive belongs to the uploading device and cannot be reused', async t => {
  const { url, manager } = await fixture(t);
  const response = await fetch(url + '/uploads', { method: 'POST', headers: { Authorization: 'Bearer secret', 'Content-Type': 'application/gzip' }, body: 'invalid archive' });
  assert.equal(response.status, 201); const { uploadId } = await response.json();
  await assert.rejects(() => manager.deploy('demo', uploadId, 'other'));
  const job = await manager.deploy('demo', uploadId, 'test');
  await assert.rejects(() => manager.deploy('demo', uploadId, 'test'));
  await manager.idle(); assert.equal(manager.job(job.deploymentId).status, 'failed');
});
test('archive rejects traversal, symbolic links, secrets, and oversized files', () => {
  for (const name of ['../escape', '/absolute', 'C:/escape', 'dir/../../escape', 'dir\\escape', '.env', 'a/private.key']) assert.throws(() => safeArchiveEntry(name, 'File', 1));
  assert.throws(() => safeArchiveEntry('link', 'SymbolicLink', 1));
  assert.throws(() => safeArchiveEntry('huge', 'File', 101 * 1024 * 1024));
  assert.doesNotThrow(() => safeArchiveEntry('src/index.js', 'File', 100));
});
test('interrupted jobs are marked failed on restart, never replayed', async t => {
  const { root, config } = await fixture(t);
  await writeFile(path.join(root, 'state.json'), JSON.stringify({ apps: {}, uploads: {}, jobs: { a: { status: 'running' } } }));
  const manager = new Manager(config, { run: async () => { throw new Error('must not run'); } });
  await manager.init(); assert.equal(manager.job('a').status, 'failed');
});
