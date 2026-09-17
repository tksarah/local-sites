import express from 'express';
// @ts-expect-error Standalone packaging helper also runs directly with Node.
import { buildSetup } from '../scripts/build-setup.mjs';
import path from 'node:path';
import { Enrollment } from './enrollment.js';
import { setupHtml, devicesHtml, devicesScript } from './setup-ui.js';
import { randomBytes } from 'node:crypto';
import type { Config } from './config.js';
import type { Manager } from './manager.js';
import { authenticate } from './security.js';
import { portalHtml, portalScript } from './portal-ui.js';
import type { Metrics } from './metrics.js';

export function portal(config: Config, manager: Manager, metrics?: Metrics) {
  const allowedOrigins = new Set([config.origin, config.portalOrigin]);
  const router = express.Router();
  const enrollment = new Enrollment(config.tokenFile);
  const setupAttempts = new Map<string, {count:number; expires:number}>();
  const sessions = new Map<string, { token: string; csrf: string; expires: number }>();
  const attempts = new Map<string, { count: number; expires: number }>();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    next();
  });
  router.get('/', (_req, res) => res.type('html').send(portalHtml));
  router.get('/portal.js', (_req, res) => res.type('application/javascript').send(portalScript));
  router.get('/setup', (_req,res)=>res.type('html').send(setupHtml.replace('__SETUP_URL__', config.origin + '/setup')));
  router.get('/devices', (_req,res)=>res.type('html').send(devicesHtml));
  router.get('/devices.js', (_req,res)=>res.type('application/javascript').send(devicesScript));
  router.get('/setup/windows.zip', async (_req,res,next)=>{try { const bytes=await buildSetup(config); res.type('application/zip').attachment('local-sites-windows.zip').send(bytes); } catch(e) {next(e);} });
  router.get('/setup/ca.crt', (_req,res)=>res.sendFile(path.join(config.root,'public-ca.crt')));
  router.use('/setup/api', express.json({limit:'2kb'}), (req,res,next)=>{
    if(req.headers.origin && !allowedOrigins.has(req.headers.origin)){res.sendStatus(403);return;}
    const now=Date.now();for(const [key,value] of setupAttempts)if(value.expires<now)setupAttempts.delete(key);
    const key=(req.socket.remoteAddress||'unknown')+(req.path==='/requests'?':create':':poll');
    const value=setupAttempts.get(key)||{count:0,expires:now+60000};
    if(setupAttempts.size>=1000&&!setupAttempts.has(key)){res.sendStatus(429);return;}
    setupAttempts.set(key,value);if(++value.count>(req.path==='/requests'?5:120)){res.sendStatus(429);return;}next();
  });
  const enrollAction=(fn:(req:express.Request)=>Promise<unknown>)=>async(req:express.Request,res:express.Response)=>{try{res.json(await fn(req));}catch(e:any){res.status(400).json({error:e.message});}};
  const secret=(req:express.Request)=>{const value=req.headers.authorization;if(!value?.startsWith('Bearer ')||value.length>128)throw Error('申請の認証が必要です。');return value.slice(7);};
  router.post('/setup/api/requests',enrollAction(req=>enrollment.create(typeof req.body?.name==='string'?req.body.name:'')));
  router.post('/setup/api/requests/:id/status',enrollAction(req=>enrollment.status(String(req.params.id),secret(req))));
  router.post('/setup/api/requests/:id/receive',enrollAction(req=>enrollment.receive(String(req.params.id),secret(req))));
  router.post('/setup/api/requests/:id/ack',enrollAction(req=>enrollment.acknowledge(String(req.params.id),secret(req))));
  router.use('/api', express.json({ limit: '8kb' }));
  router.post('/api/login', async (req, res) => {
    if (!allowedOrigins.has(req.headers.origin || '')) { res.sendStatus(403); return; }
    const now = Date.now();
    for (const [key, value] of attempts) if (value.expires < now) attempts.delete(key);
    for (const [key, value] of sessions) if (value.expires < now) sessions.delete(key);
    const ip = req.socket.remoteAddress || 'unknown';
    const attempt = attempts.get(ip) || { count: 0, expires: now + 60000 };
    attempts.set(ip, attempt);
    if (++attempt.count > 10 || sessions.size >= 1000) { res.sendStatus(429); return; }
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    try {
      if (!await authenticate(config.tokenFile, `Bearer ${token}`)) { res.sendStatus(401); return; }
      const id = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
      sessions.set(id, { token, csrf, expires: now + 8 * 3600000 });
      res.setHeader('Set-Cookie', `__Host-local-sites=${id}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=28800`);
      res.json({ csrf });
    } catch { res.sendStatus(503); }
  });
  router.use('/api', async (req, res, next) => {
    const id = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('__Host-local-sites='))?.split('=')[1] || '';
    const session = sessions.get(id);
    try {
      if (!session || session.expires < Date.now() || !await authenticate(config.tokenFile, `Bearer ${session.token}`)) {
        sessions.delete(id); res.sendStatus(401); return;
      }
      if (req.method !== 'GET' && (!allowedOrigins.has(req.headers.origin || '') || req.headers['x-csrf-token'] !== session.csrf)) { res.sendStatus(403); return; }
      res.locals.sessionId = id; res.locals.csrf = session.csrf; next();
    } catch { res.sendStatus(503); }
  });
  router.get('/api/session', (_req, res) => res.json({ csrf: res.locals.csrf }));
  router.post('/api/logout', (_req, res) => {
    sessions.delete(res.locals.sessionId);
    res.setHeader('Set-Cookie', '__Host-local-sites=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0'); res.json({ ok: true });
  });
  const action = (fn: (req: express.Request) => Promise<unknown>) => async (req: express.Request, res: express.Response) => {
    try { res.json(await fn(req)); } catch (e: any) { res.status(400).json({ error: e.message }); }
  };
  router.get('/api/devices', action(()=>enrollment.list()));
  router.post('/api/devices/requests/:id/approve', action(req=>enrollment.approve(String(req.params.id),String(req.body?.code||''))));
  router.post('/api/devices/requests/:id/reject', action(req=>enrollment.reject(String(req.params.id))));
  router.post('/api/devices/:name/revoke', action(req=>enrollment.revoke(String(req.params.name))));
  router.get('/api/apps', action(async () => (await manager.list()).map(app => ({ ...app, preview: manager.previews?.info(app.id) || { state: 'missing', mode: 'auto', url: null } }))));
  const previews = () => { if (!manager.previews) throw Error('プレビュー機能を準備中です。'); return manager.previews; };
  router.get('/api/apps/:id/preview/image', async (req, res) => {
    try {
      const data = await previews().image(String(req.params.id));
      if (!data) { res.sendStatus(404); return; }
      res.type('image/webp').send(data);
    } catch { res.sendStatus(404); }
  });
  router.post('/api/apps/:id/preview/capture', action(req => previews().request(String(req.params.id))));
  router.post('/api/apps/:id/preview/auto', action(req => previews().request(String(req.params.id), true)));
  router.post('/api/apps/:id/preview/upload', express.raw({ type: ['image/png', 'image/jpeg', 'image/webp'], limit: '5mb' }), action(req => {
    if (!Buffer.isBuffer(req.body)) throw Error('PNG・JPEG・WebPの画像を選択してください。');
    return previews().upload(String(req.params.id), req.body);
  }));
  router.use('/api/apps/:id/preview/upload', (error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.type === 'entity.too.large' ? 413 : 400).json({ error: '画像は5MB以下のPNG・JPEG・WebPを選択してください。' });
  });
  router.get('/api/metrics/current', (_req, res) => {
    if (!metrics) { res.status(503).json({ error: 'リソース計測を準備中です' }); return; }
    res.json(metrics.current());
  });
  router.get('/api/metrics/history', (req, res) => {
    if (!metrics) { res.status(503).json({ error: 'リソース計測を準備中です' }); return; }
    if (typeof req.query.range !== 'string' || (req.query.appId !== undefined && typeof req.query.appId !== 'string')) { res.status(400).json({ error: '期間とアプリの指定を確認してください' }); return; }
    try { res.json(metrics.getHistory(req.query.range, req.query.appId)); }
    catch (error: any) { res.status(400).json({ error: error.message }); }
  });
  router.get('/api/apps/:id/logs', action(req => manager.logs(String(req.params.id), 100)));
  router.post('/api/apps/:id/start', action(req => manager.setRunning(String(req.params.id), true)));
  router.post('/api/apps/:id/stop', action(req => manager.setRunning(String(req.params.id), false)));
  router.post('/api/apps/:id/delete', action(req => {
    if (typeof req.body?.purge !== 'boolean') throw new Error('purge must be boolean');
    return manager.deleteApp(String(req.params.id), req.body.purge, req.body.confirmation);
  }));
  return router;
}
