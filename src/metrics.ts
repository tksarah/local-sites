import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { readFile, mkdir, appendFile, readdir, rm, stat, statfs } from 'node:fs/promises';
import type { Manager } from './manager.js';

export type Values = { cpu: number | null; memory: number | null; memoryUsed: number | null; memoryLimit: number | null; cpuLimit: number | null; rx: number | null; tx: number | null; storage: number | null };
export type Entity = Values & { status: string; collectedAt: number | null; storageAt: number | null; error?: string };
export type Disk = { name: string; total: number; used: number; available: number; percent: number };
export type Snapshot = { timestamp: number; host: Entity & { uptime: number | null; interface: string | null; disks: Disk[] }; apps: Record<string, Entity> };
const DAY = 86400000, RETENTION = 7 * DAY;
export const emptyValues = (): Values => ({ cpu: null, memory: null, memoryUsed: null, memoryLimit: null, cpuLimit: null, rx: null, tx: null, storage: null });
const blank = (status = 'unknown'): Entity => ({ ...emptyValues(), status, collectedAt: null, storageAt: null });
export function rate(current: number, previous: number, elapsed: number): number | null {
  return Number.isFinite(current) && Number.isFinite(previous) && current >= previous && elapsed > 0 ? (current - previous) * 1000 / elapsed : null;
}
export function cpuPercent(current: number[], previous?: number[]): number | null {
  if (!previous) return null;
  const delta = current.map((v, i) => v - (previous[i] || 0));
  const total = delta.reduce((a, b) => a + b, 0);
  return total > 0 && delta.every(v => v >= 0) ? Math.max(0, Math.min(100, (total - delta[3] - delta[4]) / total * 100)) : null;
}
export function containerValues(info: any, data: any, previous?: { at: number; id: string; rx: number; tx: number }, now = Date.now()) {
  const hostCpus = data.cpu_stats?.online_cpus || data.cpu_stats?.cpu_usage?.percpu_usage?.length || 1;
  const cfg = info.HostConfig || {};
  const cpuset = typeof cfg.CpusetCpus === 'string' && cfg.CpusetCpus ? cfg.CpusetCpus.split(',').reduce((sum: number, part: string) => { const [a, b] = part.split('-').map(Number); return sum + (b === undefined ? 1 : b - a + 1); }, 0) : hostCpus;
  const cpuLimit = Math.min(cpuset, cfg.NanoCpus > 0 ? cfg.NanoCpus / 1e9 : cfg.CpuQuota > 0 && cfg.CpuPeriod > 0 ? cfg.CpuQuota / cfg.CpuPeriod : hostCpus);
  const delta = data.cpu_stats?.cpu_usage?.total_usage - data.precpu_stats?.cpu_usage?.total_usage;
  const system = data.cpu_stats?.system_cpu_usage - data.precpu_stats?.system_cpu_usage;
  const usage = data.memory_stats?.usage;
  const cache = data.memory_stats?.stats?.inactive_file ?? data.memory_stats?.stats?.total_inactive_file ?? 0;
  const memoryUsed = Number.isFinite(usage) ? Math.max(0, usage - (cache < usage ? cache : 0)) : null;
  const memoryLimit = data.memory_stats?.limit > 0 ? data.memory_stats.limit : null;
  const networks = Object.values(data.networks || {}) as any[];
  const rx = networks.length ? networks.reduce((s, n) => s + n.rx_bytes, 0) : NaN;
  const tx = networks.length ? networks.reduce((s, n) => s + n.tx_bytes, 0) : NaN;
  const continuous = previous?.id === info.Id && previous !== undefined && now - previous.at <= 90000;
  const values: Values = { ...emptyValues(), cpu: delta >= 0 && system > 0 && cpuLimit > 0 ? delta / system * hostCpus / cpuLimit * 100 : null,
    memoryUsed, memoryLimit, cpuLimit, memory: memoryUsed !== null && memoryLimit ? memoryUsed / memoryLimit * 100 : null,
    rx: continuous ? rate(rx, previous.rx, now - previous.at) : null, tx: continuous ? rate(tx, previous.tx, now - previous.at) : null };
  return { values, previous: { at: now, id: info.Id, rx, tx } };
}

export interface Engine { get(endpoint: string, timeout?: number): Promise<any> }
export class DockerMetrics implements Engine {
  private version?: string;
  constructor(private socketPath = '/var/run/docker.sock') {}
  private request(endpoint: string, timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const request = http.get({ socketPath: this.socketPath, path: endpoint }, response => {
        const chunks: Buffer[] = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 16 * 1024 * 1024) request.destroy(new Error('Metrics response too large')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => { if (response.statusCode !== 200) { reject(new Error('Docker metrics unavailable')); return; } try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { reject(new Error('Invalid Docker metrics')); } });
      });
      const timer = setTimeout(() => request.destroy(new Error('Metrics timeout')), timeout);
      request.on('error', reject); request.on('close', () => clearTimeout(timer));
    });
  }
  async get(endpoint: string, timeout = 8000) {
    if (!this.version) { const version = await this.request('/version', timeout); if (!/^1\.\d+$/.test(version.ApiVersion)) throw new Error('Invalid Docker API version'); this.version = version.ApiVersion; }
    return this.request(`/v${this.version}${endpoint}`, timeout);
  }
}

export class HostMetrics {
  private previous?: { at: number; cpu: number[]; rx: number; tx: number; iface: string };
  constructor(private root: string, private proc: string, private data: string, private siteIp: string, private network = '') {}
  setStorageRoot(dockerRoot: string) {
    if (path.posix.isAbsolute(dockerRoot) && !dockerRoot.split('/').includes('..')) this.data = path.join(this.root, dockerRoot, 'volumes');
  }
  async collect(now: number): Promise<Snapshot['host']> {
    const [cpuText, memText, netText, uptimeText, route] = await Promise.all(['stat', 'meminfo', 'net/dev', 'uptime', 'net/route'].map(file => readFile(path.join(this.proc, file), 'utf8')));
    const cpu = cpuText.split('\n')[0].trim().split(/\s+/).slice(1, 9).map(Number);
    const mem = Object.fromEntries([...memText.matchAll(/^(\w+):\s+(\d+)/gm)].map(m => [m[1], Number(m[2]) * 1024]));
    const iface = this.network || Object.entries(os.networkInterfaces()).find(([, entries]) => entries?.some(e => e.address === this.siteIp))?.[0] || route.split('\n').slice(1).map(l => l.trim().split(/\s+/)).find(p => p[1] === '00000000')?.[0] || '';
    const net = netText.split('\n').find(l => l.trim().startsWith(iface + ':'))?.split(':')[1].trim().split(/\s+/).map(Number);
    const rx = net?.[0] ?? NaN, tx = net?.[8] ?? NaN, previous = this.previous;
    this.previous = { at: now, cpu, rx, tx, iface };
    const continuous = previous && now - previous.at <= 90000;
    const disks: Disk[] = []; const devices = new Set<number>(); let diskError = false;
    for (const [name, directory] of [['OS', this.root], ['アプリ保存領域', this.data]]) {
      try {
        const [metadata, fs] = await Promise.all([stat(directory), statfs(directory)]);
        if (devices.has(metadata.dev)) { const existing = disks.find(d => d.name === 'OS'); if (existing) existing.name = 'OS・アプリ保存領域'; continue; }
        devices.add(metadata.dev); const total = fs.blocks * fs.bsize, available = fs.bavail * fs.bsize, used = (fs.blocks - fs.bfree) * fs.bsize;
        disks.push({ name, total, available, used, percent: used + available ? used / (used + available) * 100 : 0 });
      } catch { diskError = true; }
    }
    const memoryUsed = mem.MemTotal - mem.MemAvailable;
    return { ...blank('running'), collectedAt: now, storageAt: disks.length ? now : null, cpu: cpuPercent(cpu, continuous ? previous.cpu : undefined), cpuLimit: cpuText.split('\n').filter(l => /^cpu\d+\s/.test(l)).length,
      memoryUsed: Number.isFinite(memoryUsed) ? memoryUsed : null, memoryLimit: mem.MemTotal || null, memory: mem.MemTotal && Number.isFinite(memoryUsed) ? memoryUsed / mem.MemTotal * 100 : null,
      rx: continuous && previous.iface === iface ? rate(rx, previous.rx, now - previous.at) : null, tx: continuous && previous.iface === iface ? rate(tx, previous.tx, now - previous.at) : null,
      storage: disks.length ? disks.reduce((s, d) => s + d.used, 0) : null, uptime: parseFloat(uptimeText) || null, interface: iface || null, disks,
      ...(diskError || !net ? { error: 'ディスクまたは通信量の一部を取得できません' } : {}) };
  }
}

export const fields = ['cpu', 'memory', 'memoryUsed', 'memoryLimit', 'cpuLimit', 'rx', 'tx', 'storage'] as const;
export function aggregate(history: Snapshot[], range: '1h' | '24h' | '7d', now: number, appId?: string) {
  const duration = { '1h': 3600000, '24h': DAY, '7d': RETENTION }[range], step = { '1h': 30000, '24h': 300000, '7d': 900000 }[range];
  const start = Math.floor((now - duration) / step) * step, end = Math.floor(now / step) * step;
  const buckets = new Map<number, Entity[]>();
  for (const sample of history) {
    if (sample.timestamp < now - duration || sample.timestamp > now) continue;
    const entity = appId ? sample.apps[appId] : sample.host;
    if (!entity) continue;
    const key = Math.floor(sample.timestamp / step) * step, bucket = buckets.get(key) || []; bucket.push(entity); buckets.set(key, bucket);
  }
  const points = [];
  for (let at = start; at <= end; at += step) {
    const bucket = buckets.get(at) || [], average = emptyValues(), peak = emptyValues();
    for (const field of fields) {
      const values = bucket.map(e => field === 'storage' && (!e.storageAt || at - e.storageAt > 600000) ? null : e[field]).filter((v): v is number => v !== null && Number.isFinite(v));
      if (values.length) { average[field] = values.reduce((s, v) => s + v, 0) / values.length; peak[field] = Math.max(...values); }
    }
    points.push({ at, average, peak });
  }
  return { range, step, start, end: now, points };
}

export class Metrics {
  private history: Snapshot[] = [];
  private latest?: Snapshot;
  private pending?: Promise<void>;
  private volumePending?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private volumeTimer?: ReturnType<typeof setInterval>;
  private volumes = new Map<string, { size: number; at: number }>();
  private volumeError = false;
  private previous = new Map<string, { at: number; id: string; rx: number; tx: number }>();
  private warnings = new Map<string, { since: number; last: number; level: number }>();
  private activeWarnings: { entity: string; metric: string; level: string; message: string }[] = [];
  private storageError = false;
  private directory: string;
  constructor(private manager: Manager, private engine: Engine = new DockerMetrics(), private host = new HostMetrics(process.env.METRICS_HOST_ROOT || '/host/root', process.env.METRICS_HOST_PROC || '/host/proc', path.join(process.env.METRICS_HOST_ROOT || '/host/root', 'var/lib/docker/volumes'), manager.config.ip, process.env.METRICS_NETWORK_INTERFACE || ''), private clock = Date.now) { this.directory = path.join(manager.config.root, 'metrics'); }
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const files = (await readdir(this.directory)).filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
    for (const file of files) {
      if (Date.parse(file.slice(0, 10)) + DAY <= this.clock() - RETENTION) { await rm(path.join(this.directory, file)); continue; }
      const content = await readFile(path.join(this.directory, file), 'utf8');
      for (const line of content.split('\n')) {
        try { const sample = JSON.parse(line); if (sample.timestamp >= this.clock() - RETENTION && sample.timestamp <= this.clock() && sample.host && sample.apps) this.history.push(sample); } catch { /* Recover intact lines after an interrupted append. */ }
      }
    }
    this.history.sort((a, b) => a.timestamp - b.timestamp);
    this.latest = this.history.at(-1);
  }
  start() {
    if (this.timer) return;
    void this.sample(); void this.collectVolumes();
    this.timer = setInterval(() => void this.sample(), 30000); this.timer.unref();
    this.volumeTimer = setInterval(() => void this.collectVolumes(), 300000); this.volumeTimer.unref();
  }
  async stop() { clearInterval(this.timer); clearInterval(this.volumeTimer); this.timer = undefined; await Promise.all([this.pending, this.volumePending]); }
  collectVolumes() {
    if (this.volumePending) return this.volumePending;
    this.volumePending = (async () => {
      try {
        if (this.host.setStorageRoot) {
          const info = await this.engine.get('/info');
          if (typeof info.DockerRootDir === 'string') this.host.setStorageRoot(info.DockerRootDir);
        }
        const data = await this.engine.get('/system/df?type=volume', 20000), at = this.clock();
        const result = new Map<string, { size: number; at: number }>();
        for (const id of Object.keys(this.manager.state.apps)) {
          const volume = data.Volumes?.find((v: any) => v.Name === `local-sites-data-${id}`);
          if (Number.isFinite(volume?.UsageData?.Size) && volume.UsageData.Size >= 0) result.set(id, { size: volume.UsageData.Size, at });
        }
        this.volumes = result; this.volumeError = false;
      } catch { this.volumeError = true; }
    })().finally(() => { this.volumePending = undefined; });
    return this.volumePending;
  }
  sample() {
    if (this.pending) return this.pending;
    this.pending = this.collect().catch(() => { this.storageError = true; }).finally(() => { this.pending = undefined; });
    return this.pending;
  }
  private async collect() {
    const timestamp = this.clock();
    const snapshot: Snapshot = { timestamp, host: { ...blank(), uptime: null, interface: null, disks: [] }, apps: {} };
    try { snapshot.host = await this.host.collect(timestamp); } catch { snapshot.host.error = 'サーバー統計を取得できません'; }
    const entries = Object.entries(this.manager.state.apps); let index = 0;
    const worker = async () => { while (index < entries.length) {
      const [id, app] = entries[index++]; let entity = blank(app.deletedAt ? 'deleted' : 'unknown');
      try {
        if (!app.deletedAt) {
          const info = await this.engine.get(`/containers/${encodeURIComponent('local-sites-' + id)}/json`);
          if (info.Config?.Labels?.['local-sites.app'] !== id) throw new Error('ownership');
          entity.status = info.State?.Status || 'unknown';
          if (entity.status === 'running') {
            const data = await this.engine.get(`/containers/${encodeURIComponent(info.Id)}/stats?stream=false`);
            const result = containerValues(info, data, this.previous.get(id), timestamp);
            entity = { ...entity, ...result.values, collectedAt: timestamp }; this.previous.set(id, result.previous);
          } else { entity.collectedAt = timestamp; this.previous.delete(id); }
        } else { entity.collectedAt = timestamp; this.previous.delete(id); }
      } catch { entity.error = 'アプリ統計を取得できません'; this.previous.delete(id); }
      const volume = this.volumes.get(id);
      if (volume) { entity.storage = volume.size; entity.storageAt = volume.at; }
      snapshot.apps[id] = entity;
    } };
    await Promise.all(Array.from({ length: Math.min(4, entries.length) }, worker));
    this.latest = snapshot; this.history.push(snapshot); this.history = this.history.filter(s => s.timestamp >= timestamp - RETENTION);
    this.updateWarnings(snapshot);
    try {
      // Leading newline isolates any partial record left by an interrupted process.
      await appendFile(path.join(this.directory, new Date(timestamp).toISOString().slice(0, 10) + '.jsonl'), '\n' + JSON.stringify(snapshot) + '\n', { mode: 0o600 });
      for (const file of await readdir(this.directory)) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && Date.parse(file.slice(0, 10)) + DAY <= timestamp - RETENTION) await rm(path.join(this.directory, file));
      this.storageError = false;
    } catch { this.storageError = true; }
  }
  private updateWarnings(snapshot: Snapshot) {
    const warnings: typeof this.activeWarnings = [], seen = new Set<string>();
    for (const [id, entity] of [['host', snapshot.host], ...Object.entries(snapshot.apps)] as [string, Entity][]) for (const metric of ['cpu', 'memory'] as const) {
      let active = 0;
      for (const threshold of [85, 95]) {
        const key = id + ':' + metric + ':' + threshold, value = entity[metric]; seen.add(key);
        if (value === null || value < threshold) { this.warnings.delete(key); continue; }
        const old = this.warnings.get(key);
        const record = old && snapshot.timestamp - old.last <= 90000 ? { ...old, last: snapshot.timestamp } : { since: snapshot.timestamp, last: snapshot.timestamp, level: threshold };
        this.warnings.set(key, record);
        if (snapshot.timestamp - record.since >= 180000) active = threshold;
      }
      if (active) warnings.push({ entity: id, metric, level: active === 95 ? 'critical' : 'warning', message: `${id === 'host' ? 'サーバー' : id}：${metric === 'cpu' ? 'CPU' : 'メモリ'}が${active}%以上で3分継続` });
    }
    for (const key of this.warnings.keys()) if (!seen.has(key)) this.warnings.delete(key);
    for (const disk of snapshot.host.disks) if (disk.percent >= 85) warnings.push({ entity: 'host', metric: 'storage', level: disk.percent >= 95 ? 'critical' : 'warning', message: `${disk.name}：ディスク使用率 ${disk.percent.toFixed(1)}%` });
    this.activeWarnings = warnings;
  }
  current() {
    const now = this.clock();
    const latest = this.latest || { timestamp: null, host: { ...blank(), uptime: null, interface: null, disks: [] }, apps: {} as Record<string, Entity> };
    const apps = Object.fromEntries(Object.keys(this.manager.state.apps).filter(id => id in latest.apps).map(id => [id, latest.apps[id]]));
    return { ...latest, apps, now, interval: 30000, stale: !latest.host.collectedAt || now - latest.host.collectedAt > 90000,
      warnings: this.activeWarnings.filter(w => w.entity === 'host' || w.entity in this.manager.state.apps), storageError: this.storageError, volumeError: this.volumeError,
      sparklines: Object.fromEntries(Object.keys(apps).map(id => [id, this.history.filter(s => s.timestamp >= now - 3600000).map(s => ({ at: s.timestamp, value: s.apps[id]?.cpu ?? null }))])) };
  }
  getHistory(range: string, appId?: string) {
    if (!['1h', '24h', '7d'].includes(range)) throw new Error('期間は1h、24h、7dを指定してください');
    if (appId !== undefined && !Object.hasOwn(this.manager.state.apps, appId)) throw new Error('アプリが見つかりません');
    return aggregate(this.history, range as '1h' | '24h' | '7d', this.clock(), appId);
  }
}
