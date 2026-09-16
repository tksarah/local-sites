import express from 'express';
import { randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { configuration, type Config } from './config.js';
import { authenticate } from './security.js';
import { Manager } from './manager.js';
import { Docker } from './docker.js';
import { portal } from './portal.js';
import { Metrics } from './metrics.js';

export function createApp(config: Config, manager: Manager, metrics?: Metrics) {
  const app = express(); app.disable('x-powered-by');
  app.use(portal(config, manager, metrics));
  app.use(async (req, res, next) => {
    if (req.headers.origin && ![config.origin, config.portalOrigin].includes(req.headers.origin)) { res.status(403).json({ error: 'Origin denied' }); return; }
    try {
      const owner = await authenticate(config.tokenFile, req.headers.authorization);
      if (!owner) { res.setHeader('WWW-Authenticate', 'Bearer'); res.status(401).json({ error: 'Unauthorized' }); return; }
      res.locals.owner = owner; next();
    } catch { res.status(503).json({ error: 'Authentication unavailable' }); }
  });
  app.post('/uploads', async (req, res) => {
    if (!req.is('application/gzip')) { res.status(415).json({ error: 'Use application/gzip' }); return; }
    const id = randomUUID(), file = path.join(config.root, 'uploads', `${id}.tgz`);
    let size = 0;
    const limit = new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length; callback(size > 25 * 1024 * 1024 ? new Error('Upload exceeds 25 MiB') : null, chunk);
    }});
    try {
      await pipeline(req, limit, createWriteStream(file, { flags: 'wx', mode: 0o600 }));
      await manager.addUpload(id, res.locals.owner); res.status(201).json({ uploadId: id, expiresInSeconds: 86400 });
    } catch { await rm(file, { force: true }); if (!res.headersSent) res.status(400).json({ error: 'Upload failed or exceeds 25 MiB' }); }
  });
  app.post('/mcp', express.json({ limit: '1mb' }), async (req, res) => {
    const server = new McpServer({ name: 'local-sites', version: '0.1.0' });
    const owner = res.locals.owner as string;
    const tool = (name: string, description: string, inputSchema: any, operation: (args: any) => Promise<unknown> | unknown, readOnly = false) => {
      server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false } }, async (args: any) => {
        try { return { content: [{ type: 'text' as const, text: JSON.stringify(await operation(args)) }] }; }
        catch (error: any) { return { isError: true, content: [{ type: 'text' as const, text: error.message }] }; }
      });
    };
    const appId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
    tool('deploy_app', 'Deploy an uploaded application; returns an asynchronous deployment ID. Updates preserve the URL and data volume.', { appId, uploadId: z.string().uuid() }, a => manager.deploy(a.appId, a.uploadId, owner));
    tool('get_deployment_status', 'Get deployment progress, errors, and URL on success.', { deploymentId: z.string().uuid() }, a => manager.job(a.deploymentId), true);
    tool('list_apps', 'List managed applications and current container states.', {}, () => manager.list(), true);
    tool('get_app_status', 'Inspect one managed application.', { appId }, a => manager.status(a.appId), true);
    tool('get_app_logs', 'Read recent application logs. Logs may contain private application data.', { appId, lines: z.number().int().min(1).max(200).default(50) }, a => manager.logs(a.appId, a.lines), true);
    tool('start_app', 'Start a managed application.', { appId }, a => manager.setRunning(a.appId, true));
    tool('stop_app', 'Stop a managed application without deleting its data.', { appId }, a => manager.setRunning(a.appId, false));
    tool('get_portal_url', 'Get the login-protected application management portal URL.', {}, () => ({ url: config.portalOrigin }), true);
    tool('delete_app', 'Delete a managed app. By default preserve its data and URL for redeployment. purge permanently deletes saved data and requires confirmation equal to appId.', { appId, purge: z.boolean().default(false), confirmation: z.string().default('') }, a => manager.deleteApp(a.appId, a.purge, a.confirmation));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' }); }
  });
  app.all('/mcp', (_req, res) => { res.setHeader('Allow', 'POST'); res.status(405).end(); });
  return app;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = configuration(), manager = new Manager(config, new Docker()); await manager.init();
  const metrics = new Metrics(manager);
  try { await metrics.init(); } catch { console.error('Metrics history unavailable; app management remains available.'); }
  metrics.start();
  const server = createApp(config, manager, metrics).listen(config.port, config.bind, () => console.log(`local-sites listening on ${config.bind}:${config.port}`));
  const shutdown = () => { server.close(); void metrics.stop().then(() => process.exit(0)); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
