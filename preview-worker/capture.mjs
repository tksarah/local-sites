import { chromium } from 'playwright';
import sharp from 'sharp';
import { pathToFileURL } from 'node:url';

// Browser requests retain the public origin, but transport is pinned to this app's
// network namespace. Never follow redirects in the transport: every redirected
// browser request must pass the same origin check again.
export async function capture(publicUrl, transport = 'http://127.0.0.1:3000', launchOptions = {}) {
  const origin = new URL(publicUrl).origin;
  if (!/^https?:$/.test(new URL(origin).protocol)) throw Error('Unsupported origin');
  const browser = await chromium.launch({ headless: true, args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'], ...launchOptions });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1,
      serviceWorkers: 'block', acceptDownloads: false, locale: 'ja-JP', reducedMotion: 'reduce' });
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== origin || !['GET', 'HEAD'].includes(request.method())) return route.abort();
      const target = new URL(transport); target.pathname = url.pathname; target.search = url.search;
      try {
        const response = await route.fetch({ url: target.href, maxRedirects: 0, maxRetries: 0, timeout: 10000,
          headers: { ...request.headers(), host: new URL(origin).host } });
        await route.fulfill({ response });
      } catch { await route.abort().catch(() => {}); }
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const response = await page.goto(origin + '/', { waitUntil: 'load', timeout: 20000 });
    if (!response || response.status() >= 400) throw Error('Application unavailable');
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(1000);
    return await sharp(await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', timeout: 5000 })).webp({ quality: 82 }).toBuffer();
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const deadline = setTimeout(() => process.exit(1), 28000);
  try { process.stdout.write((await capture(process.argv[2])).toString('base64')); }
  catch { process.stderr.write('Preview capture failed.\n'); process.exitCode = 1; }
  finally { clearTimeout(deadline); }
}
