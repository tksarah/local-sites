import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { configuration } from '../dist/config.js';
import { buildSetup } from '../scripts/build-setup.mjs';
import { createApp } from '../dist/server.js';

function unpack(bytes) {
  const result = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    const length = bytes.readUInt32LE(offset + 18), nameLength = bytes.readUInt16LE(offset + 26), extra = bytes.readUInt16LE(offset + 28);
    const name = bytes.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extra;
    result.set(name, bytes.subarray(start, start + length).toString());
    offset = start + length;
  }
  return result;
}

test('configuration rejects malformed networks and server outside network', () => {
  for (const cidr of ['10.20.0.0/33', '10.20.0.0/x', '10.20.0.1/16', '10.21.0.0/16', '::/0']) {
    assert.throws(() => configuration({ SITE_IP: '10.20.5.9', LAN_CIDR: cidr }));
  }
  assert.equal(configuration({ SITE_IP: '10.20.5.9', LAN_CIDR: '10.20.0.0/16' }).lanCidr, '10.20.0.0/16');
});

test('runtime ZIP carries one consistent configuration, with and without DNS', async () => {
  for (const appDomain of ['', 'apps.home.arpa']) {
    const config = configuration({ SITE_IP: '10.20.5.9', LAN_CIDR: '10.20.0.0/16', APP_DOMAIN: appDomain, GATEWAY_CONTAINER: 'gateway' });
    const entries = unpack(await buildSetup(config));
    const prefix = 'local-sites-windows/';
    const connection = JSON.parse(entries.get(prefix + 'connection.json'));
    assert.equal(connection.serverUrl, 'https://10.20.5.9');
    assert.equal(connection.appDomain, appDomain);
    assert.equal(connection.lanCidr, '10.20.0.0/16');
    assert.deepEqual(JSON.parse(entries.get(prefix + 'plugin/connection.json')), connection);
    const mcp = JSON.parse(entries.get(prefix + 'plugin/.mcp.json'));
    assert.equal(mcp.mcpServers['local-sites'].url, connection.serverUrl + '/mcp');
    assert.equal(mcp.mcpServers['local-sites'].bearer_token_env_var, 'LOCAL_SITES_TOKEN');
    assert.equal(entries.size, 17);
    for (const [name, text] of entries) {
      assert.doesNotMatch(name, /\.(token|key|pem|crt|log)$|node_modules|\.local-sites/);
      assert.doesNotMatch(text, /-----BEGIN .*PRIVATE KEY-----/);
      assert.doesNotMatch(text, /configure-before-use\.invalid/);
    }
  }
});

test('setup page and download use server config, never request Host', async t => {
  const root=await mkdtemp(path.join(os.tmpdir(),'setup-download-'));
  t.after(()=>rm(root,{recursive:true,force:true,maxRetries:3}));
  const config = configuration({ DATA_DIR:root, SITE_IP: '10.20.5.9', LAN_CIDR: '10.20.0.0/16' });
  const app = createApp(config, {});
  const server = app.listen(0, '127.0.0.1');
  await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const origin = 'http://127.0.0.1:' + server.address().port;
  await fetch(origin+'/setup/api/requests',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  const html = await (await fetch(origin + '/setup', {headers: {Host: 'evil.example'}})).text();
  assert.match(html, /https:\/\/10\.20\.5\.9\/setup/);
  assert.doesNotMatch(html, /evil\.example|__SETUP_URL__/);
  const response = await fetch(origin + '/setup/windows.zip', {headers: {Host: 'evil.example'}});
  assert.equal(response.status, 200);
  const entries = unpack(Buffer.from(await response.arrayBuffer()));
  assert.equal(JSON.parse(entries.get('local-sites-windows/connection.json')).serverUrl, config.origin);
});
