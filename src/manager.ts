import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import type { Config } from './config.js';
import type { Runner } from './docker.js';
import { extractArchive } from './archive.js';

type App = { id: string; port: number; image?: string; desired: 'running' | 'stopped'; url: string; deletedAt?: string; updatedAt?: string };
type Job = { id: string; appId: string; uploadId: string; requestedBy: string; status: 'queued' | 'running' | 'succeeded' | 'failed'; createdAt: string; error?: string; url?: string };
type Upload = { owner: string; createdAt: number; consumed?: boolean };
type State = { apps: Record<string, App>; jobs: Record<string, Job>; uploads: Record<string, Upload> };
export const validId = (id: string) => /^[a-z][a-z0-9-]{0,39}$/.test(id) && !(id in Object.prototype);
export class Manager {
  state: State = { apps: {}, jobs: {}, uploads: {} };
  private tail: Promise<unknown> = Promise.resolve();
  private writes: Promise<unknown> = Promise.resolve();
  constructor(readonly config: Config, readonly docker: Runner) {}
  private file() { return path.join(this.config.root, 'state.json'); }
  private appUrl(app: App) {
    return this.config.appDomain ? `https://${app.id}.${this.config.appDomain}` : `https://${this.config.ip}:${app.port}`;
  }
  async init() {
    await mkdir(path.join(this.config.root, 'uploads'), { recursive: true });
    try { this.state = JSON.parse(await readFile(this.file(), 'utf8')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (this.config.appDomain && Object.hasOwn(this.state.apps, 'portal')) throw new Error('App ID portal is reserved for the management portal; resolve the existing app before enabling APP_DOMAIN');
    // Never silently replay a deployment after a service crash.
    for (const job of Object.values(this.state.jobs)) if (['queued', 'running'].includes(job.status)) {
      job.status = 'failed'; job.error = 'Service restarted during deployment; inspect application and deploy again.';
    }
    await this.save();
    if (this.config.gatewayContainer) {
      for (const app of Object.values(this.state.apps)) {
        const info = await this.inspect(app.id);
        const bindings = info?.HostConfig?.PortBindings?.['3000/tcp'] || [];
        if (info && bindings.some((b: any) => b.HostIp !== '127.0.0.1')) {
          // Keep the existing image and volume, changing only the listening interface.
          await this.docker.run(['rm', '-f', this.name(app.id)]);
          await this.runApp(app, info.Image);
          if (app.desired === 'stopped') await this.docker.run(['stop', this.name(app.id)]);
        }
        app.url = this.appUrl(app);
      }
      for (const job of Object.values(this.state.jobs)) {
        if (job.url && Object.hasOwn(this.state.apps, job.appId)) job.url = this.appUrl(this.state.apps[job.appId]);
      }
      await this.save();
      await this.syncGateway();
    }
  }
  private async syncGateway() {
    if (!this.config.gatewayContainer) return;
    const directory = path.join(this.config.root, 'gateway');
    await mkdir(directory, { recursive: true });
    const portalRoute = this.config.appDomain ? `${this.config.portalOrigin} {
  bind ${this.config.ip}
  tls internal
  @outside not remote_ip {$LAN_CIDR} 127.0.0.1 ::1
  respond @outside "LAN access only" 403
  reverse_proxy 127.0.0.1:${this.config.port}
}\n` : '';
    const routes = portalRoute + Object.values(this.state.apps).map(app => `https://${this.config.ip}:${app.port}${this.config.appDomain ? `, ${this.appUrl(app)}` : ''} {
  bind ${this.config.ip}
  tls internal
  @outside not remote_ip {$LAN_CIDR} 127.0.0.1 ::1
  respond @outside "LAN access only" 403
  reverse_proxy 127.0.0.1:${app.port} {
    header_up Cookie "(^|; *)__Host-local-sites=[^;]*" ""
  }
}`).join('\n');
    await writeFile(path.join(directory, 'apps.caddy.tmp'), routes + '\n');
    await rename(path.join(directory, 'apps.caddy.tmp'), path.join(directory, 'apps.caddy'));
    await this.docker.run(['exec', this.config.gatewayContainer, 'caddy', 'reload', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile']);
  }
  private save() {
    const content = JSON.stringify(this.state, null, 2);
    const operation = this.writes.then(async () => {
      const temp = this.file() + '.tmp';
      await writeFile(temp, content, { mode: 0o600 }); await rename(temp, this.file());
    });
    this.writes = operation.catch(() => {}); return operation;
  }
  async addUpload(id: string, owner: string) {
    this.state.uploads[id] = { owner, createdAt: Date.now() }; await this.save();
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation); this.tail = next.catch(() => {}); return next;
  }
  async deploy(appId: string, uploadId: string, owner: string) {
    if (this.config.appDomain && appId === 'portal') throw new Error('App ID portal is reserved for the management portal');
    if (!validId(appId)) throw new Error('Invalid app ID: use lowercase letters, digits and hyphens, starting with a letter (max 40).');
    const upload = this.state.uploads[uploadId];
    if (!upload || upload.owner !== owner || upload.consumed || Date.now() - upload.createdAt > 86400000) throw new Error('Upload missing, expired, consumed, or owned by another client');
    upload.consumed = true;
    const job: Job = { id: randomUUID(), appId, uploadId, requestedBy: owner, status: 'queued', createdAt: new Date().toISOString() };
    this.state.jobs[job.id] = job; await this.save();
    void this.enqueue(() => this.execute(job)).catch(error => console.error('Deployment persistence failure:', error.message));
    return { deploymentId: job.id, status: job.status };
  }
  job(id: string) { const job = this.state.jobs[id]; if (!job) throw new Error('Unknown deployment'); return job; }
  private app(id: string) { if (!Object.hasOwn(this.state.apps, id)) throw new Error('Unknown app'); return this.state.apps[id]; }
  private name(id: string) { return `local-sites-${id}`; }
  private async inspect(id: string): Promise<any | undefined> {
    let output: string;
    try { output = await this.docker.run(['inspect', this.name(id)]); }
    catch (error: any) { if (/No such (object|container)/i.test(error.message)) return; throw error; }
    const info = JSON.parse(output)[0];
    if (info.Config?.Labels?.['local-sites.app'] !== id) throw new Error('Container ownership mismatch');
    return info;
  }
  async status(id: string) {
    const app = this.app(id), info = await this.inspect(id);
    return { ...app, status: app.deletedAt ? 'deleted' : info?.State?.Status || 'not-created', health: info?.State?.Health?.Status || 'unknown' };
  }
  async list() { return Promise.all(Object.keys(this.state.apps).map(id => this.status(id))); }
  async logs(id: string, lines: number) {
    this.app(id); if (!await this.inspect(id)) throw new Error('Container not created');
    return { logs: await this.docker.run(['logs', '--tail', String(Math.max(1, Math.min(200, lines))), this.name(id)]) };
  }
  async setRunning(id: string, running: boolean) {
    return this.enqueue(async () => {
      const app = this.app(id); if (app.deletedAt) throw new Error('Deleted app: deploy again with the same ID to restore');
      if (!await this.inspect(id)) throw new Error('Container not created');
      await this.docker.run([running ? 'start' : 'stop', this.name(id)]);
      app.desired = running ? 'running' : 'stopped'; await this.save(); return this.status(id);
    });
  }
  async deleteApp(id: string, purge = false, confirmation = '') {
    if (!validId(id)) throw new Error('Invalid app ID');
    if (purge && confirmation !== id) throw new Error('Complete deletion requires the exact app ID as confirmation');
    return this.enqueue(async () => {
      const app = this.app(id);
      if (Object.values(this.state.jobs).some(j => j.appId === id && ['queued', 'running'].includes(j.status))) throw new Error('Deployment in progress; retry when finished');
      if (await this.inspect(id)) await this.docker.run(['rm', '-f', this.name(id)]);
      app.desired = 'stopped'; app.deletedAt ||= new Date().toISOString();
      await this.save();
      if (purge) {
        // Remove only the exact volume belonging to this registered application.
        const volume = `local-sites-data-${id}`;
        let exists = true;
        try { await this.docker.run(['volume', 'inspect', volume]); }
        catch (error: any) { if (/no such volume/i.test(error.message)) exists = false; else throw error; }
        if (exists) await this.docker.run(['volume', 'rm', volume]);
        delete this.state.apps[id]; await this.save(); await this.syncGateway();
      }
      return { appId: id, deleted: true, dataRetained: !purge };
    });
  }
  private async freePort(port: number, host = this.config.ip) {
    return new Promise<boolean>(resolve => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, host, () => server.close(() => resolve(true)));
    });
  }
  private async allocatePort() {
    const used = new Set(Object.values(this.state.apps).map(a => a.port));
    for (let port = this.config.portStart; port <= this.config.portEnd; port++) if (!used.has(port) && await this.freePort(port) && await this.freePort(port, '127.0.0.1')) return port;
    throw new Error('No free application ports');
  }
  private async runApp(app: App, image: string) {
    await this.docker.run(['run', '-d', '--name', this.name(app.id), '--label', `local-sites.app=${app.id}`,
      '--restart', 'unless-stopped', '--init', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
      '--memory', '512m', '--cpus', '1', '--pids-limit', '128', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
      '-p', `127.0.0.1:${app.port}:3000`, '-e', 'PORT=3000', '-e', 'DATA_DIR=/data',
      '-v', `local-sites-data-${app.id}:/data`, image]);
  }
  private async waitHealthy(app: App) {
    for (let i = 0; i < 30; i++) {
      try { const response = await fetch(`http://127.0.0.1:${app.port}/healthz`, { signal: AbortSignal.timeout(2000), redirect: 'error' }); await response.body?.cancel(); if (response.ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    throw new Error('Application /healthz did not become healthy');
  }
  private async execute(job: Job) {
    const archive = path.join(this.config.root, 'uploads', `${job.uploadId}.tgz`);
    const directory = path.join(this.config.root, 'builds', job.id);
    let app = this.state.apps[job.appId], replaced = false;
    const previousImage = app?.deletedAt ? undefined : app?.image, previousDesired = app?.desired;
    try {
      job.status = 'running'; await this.save();
      await extractArchive(archive, directory);
      const spec = JSON.parse(await readFile(path.join(directory, 'local-sites.json'), 'utf8'));
      if (spec.version !== 1 || spec.containerPort !== 3000 || spec.healthPath !== '/healthz') throw new Error('Unsupported local-sites.json; require version 1, containerPort 3000, healthPath /healthz');
      await readFile(path.join(directory, 'Dockerfile'));
      const image = `local-sites/${job.appId}:${job.id}`;
      await this.docker.run(['build', '--label', `local-sites.app=${job.appId}`, '-t', image, directory], 600000);
      if (!app) {
        app = { id: job.appId, port: await this.allocatePort(), desired: 'running', url: '' };
        app.url = this.appUrl(app); this.state.apps[app.id] = app; await this.save();
      }
      const existing = await this.inspect(app.id);
      if (existing) await this.docker.run(['rm', '-f', this.name(app.id)]);
      replaced = true;
      await this.runApp(app, image); await this.waitHealthy(app);
      await this.syncGateway();
      app.image = image; app.desired = 'running'; delete app.deletedAt; app.updatedAt = new Date().toISOString(); job.status = 'succeeded'; job.url = app.url;
    } catch (error: any) {
      job.status = 'failed'; job.error = String(error.message).slice(-16000);
      if (app && replaced) {
        try {
          if (await this.inspect(app.id)) await this.docker.run(['rm', '-f', this.name(app.id)]);
          if (previousImage) {
            await this.runApp(app, previousImage);
            if (previousDesired === 'stopped') await this.docker.run(['stop', this.name(app.id)]);
          }
        } catch (recovery: any) { job.error += `\nRecovery failed: ${recovery.message}`; }
      }
    } finally {
      await this.save();
      await rm(archive, { force: true }); await rm(directory, { recursive: true, force: true });
    }
  }
  async idle() { await this.tail; }
}
