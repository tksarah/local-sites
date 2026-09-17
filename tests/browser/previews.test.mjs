import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { capture } from '../../preview-worker/capture.mjs';
import { portalHtml, portalScript } from '../../dist/portal-ui.js';

const launch = process.env.PREVIEW_BROWSER_CHANNEL ? { channel: process.env.PREVIEW_BROWSER_CHANNEL } : {};
const out = '.local-sites/preview-qa';
const landing = (title, color = '#e9f0e9') => `<!doctype html><html lang="ja"><meta charset="utf-8"><style>body{margin:0;background:${color};color:#172e30;font:20px system-ui;padding:50px 70px}nav{font-size:16px;display:flex;justify-content:space-between;border-bottom:1px solid #aaa;padding-bottom:22px}h1{font-size:60px;margin:60px 0 20px}p{color:#53696a}button{padding:15px 24px;border:0;border-radius:8px;background:#184e4c;color:white;font-size:18px}.tile{display:inline-block;margin:40px 15px 0 0;padding:24px;background:#fff9;border-radius:15px;width:26%}</style><nav>${title}<span>ホーム　 /　 ノート</span></nav><h1>${title}</h1><p>日々の記録を、いつでも手元に。</p><button>はじめる →</button><div><span class="tile">記録する</span><span class="tile">振り返る</span><span class="tile">見つける</span></div></html>`;
async function serve(t, handler) {
  const server = http.createServer(handler).listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); });
  return 'http://127.0.0.1:' + server.address().port;
}

test('worker captures actual pages while blocking foreign redirects, POSTs and sockets', { timeout: 60000 }, async t => {
  let foreign = 0, mutations = 0, cookies = [];
  const target = await serve(t, (_req, res) => { foreign++; res.end('blocked'); });
  const app = await serve(t, (req, res) => {
    cookies.push(req.headers.cookie);
    if (req.method === 'POST') mutations++;
    if (req.url === '/redirect') { res.writeHead(302, { Location: target + '/private' }); res.end(); return; }
    res.setHeader('Content-Type', 'text/html');
    res.end(landing('今日のノート') + `<img src="/redirect"><script>fetch('/mutate',{method:'POST'}).catch(()=>{});fetch('${target}/admin').catch(()=>{});new WebSocket('${target.replace('http:', 'ws:')}/socket')</script>`);
  });
  const image = await capture('https://app.test', app, launch);
  const meta = await sharp(image).metadata(); assert.equal(meta.width, 1280); assert.equal(meta.height, 720); assert.equal(meta.format, 'webp');
  assert.equal(foreign, 0); assert.equal(mutations, 0); assert.ok(cookies.every(c => !c));
  await mkdir(out, { recursive: true }); await sharp(image).toFile(out + '/worker.webp');
});

test('cards, preview settings and periodic refresh work at desktop and mobile widths', { timeout: 60000 }, async t => {
  const browser = await chromium.launch(launch); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 } });
  context.setDefaultTimeout(10000);
  const page = await context.newPage(), errors = []; page.on('pageerror', e => errors.push(e.message));
  const apps = ['mcp-learning-notes', 'one-line-diary', 'private-album'].map((id, i) => ({ id, url: `https://${id}.home.arpa`, status: 'running', preview: { mode: 'auto', state: 'ready', url: `/api/apps/${id}/preview/image?v=1`, updatedAt: new Date().toISOString() } }));
  const images = [];
  for (const [i, a] of apps.entries()) {
    if (process.env.PREVIEW_QA_LAN === '1') { images.push(await readFile(out + '/lan-' + a.id + '.webp')); continue; }
    const lp = await context.newPage(); await lp.setViewportSize({ width: 1280, height: 720 });
    await lp.setContent(landing(['学びを、少しずつ。', '今日を、一行に。', '大切な瞬間を。'][i], ['#e9f0e9', '#f8eddc', '#e6eafa'][i]));
    images.push(await sharp(await lp.screenshot()).webp().toBuffer()); await lp.close();
  }
  let imageRequests = 0, expired = false, failImages = false;
  await context.route('https://portal.test/**', async route => {
    const req = route.request(), url = new URL(req.url()), pathname = url.pathname;
    if (pathname === '/') return route.fulfill({ contentType: 'text/html', body: portalHtml });
    if (pathname === '/portal.js') return route.fulfill({ contentType: 'application/javascript', body: portalScript });
    if (expired) return route.fulfill({ status: 401, body: '{}' });
    if (pathname === '/api/session') return route.fulfill({ json: { csrf: 'test' } });
    if (pathname === '/api/apps') return route.fulfill({ json: apps });
    if (pathname === '/api/metrics/current') return route.fulfill({ json: { host: { collectedAt: Date.now(), cpu: 2, memory: 10, memoryUsed: 1e9, memoryLimit: 8e9, disks: [] }, apps: Object.fromEntries(apps.map((a,i) => [a.id, { cpu: 0.1, memoryUsed: (i+1)*32e6, memoryLimit: 512e6, storage: 2048, collectedAt: Date.now() }])), warnings: [] } });
    if (pathname === '/api/metrics/history') return route.fulfill({ json: { points: [] } });
    const i = apps.findIndex(a => pathname.includes('/apps/' + a.id + '/preview/'));
    if (i >= 0) {
      const p = apps[i].preview;
      if (pathname.endsWith('/image')) { imageRequests++; return route.fulfill(failImages ? { status: 404, body: '' } : { contentType: 'image/webp', body: images[i] }); }
      if (pathname.endsWith('/upload')) Object.assign(p, { mode: 'manual', state: 'ready', url: `/api/apps/${apps[i].id}/preview/image?v=2` });
      else Object.assign(p, { mode: 'auto', state: 'queued' });
      return route.fulfill({ json: p });
    }
    return route.fulfill({ status: 404, body: '{}' });
  });
  await page.goto('https://portal.test/#apps');
  await page.waitForFunction(() => document.querySelectorAll('.app-preview img:not([hidden])').length === 3);
  const cards = page.locator('.app-card'); assert.equal(await cards.count(), 3);
  assert.equal(await page.locator('.app-card .spark').count(), 0);
  const columns = () => page.locator('#appList').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length);
  assert.equal(await columns(), 3);
  await mkdir(out, { recursive: true }); await page.screenshot({ path: out + '/desktop.png', fullPage: true });
  const before = imageRequests;
  await page.locator('.more summary').first().click();
  await page.locator('.more').first().getByRole('button', { name: 'プレビュー設定' }).click();
  await page.locator('#previewImage:not([hidden])').waitFor();
  await page.locator('#previewFile').setInputFiles({ name: 'portrait.png', mimeType: 'image/png', buffer: images[0] });
  await page.waitForFunction(() => document.getElementById('previewMeta').textContent.includes('手動登録'));
  assert.ok(await page.locator('#autoPreview').isVisible());
  await page.screenshot({ path: out + '/settings.png' });
  await page.locator('#autoPreview').click();
  await page.waitForFunction(() => document.getElementById('previewState').textContent === '撮影待ち');
  assert.ok(await page.locator('#capturePreview').isDisabled());
  await page.locator('#closePreview').click();
  await page.locator('#search').fill('diary'); assert.equal(await page.locator('.app-card:visible').count(), 1);
  await page.locator('#search').fill('');
  await page.locator('#sort').selectOption('memoryUsed');
  await page.locator('#search').focus(); const afterChanges = imageRequests;
  await page.evaluate(() => refresh());
  assert.equal(await page.locator('#search').evaluate(el => el === document.activeElement), true);
  assert.equal(imageRequests, afterChanges); assert.ok(imageRequests >= before);
  assert.equal(await cards.first().locator('h3').innerText(), 'private-album');
  await page.setViewportSize({ width: 900, height: 1000 }); assert.equal(await columns(), 2);
  await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await columns(), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.screenshot({ path: out + '/mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  const firstHeight = await cards.first().evaluate(el => el.offsetHeight);
  const first = apps.find(a => a.id === 'private-album'); first.preview = { mode: 'auto', state: 'failed', url: null };
  await page.evaluate(() => refresh()); assert.equal(await cards.first().evaluate(el => el.offsetHeight), firstHeight);
  assert.ok(await cards.first().locator('.preview-placeholder').getByText('撮影できませんでした').isVisible());
  failImages = true; first.preview.url = '/api/apps/private-album/preview/image?v=broken'; await page.evaluate(() => refresh());
  await cards.first().getByText('画像を表示できません').waitFor();
  expired = true; await page.evaluate(() => refresh()); assert.ok(await page.locator('#login').isVisible());
  assert.deepEqual(errors, []);
});
