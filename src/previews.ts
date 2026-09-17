import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import type { Manager } from './manager.js';
import { validId } from './manager.js';

type RecordData = { mode: 'auto' | 'manual'; state: 'missing' | 'queued' | 'capturing' | 'ready' | 'failed'; revision: string; version?: string; updatedAt?: string; error?: string };
export type Capture = (id: string, url: string) => Promise<Buffer>;
const maxBytes = 5 * 1024 * 1024;

export async function normalizePreview(input: Buffer) {
  if (!input.length || input.length > maxBytes) throw Error('画像は5MB以下で選択してください。');
  try {
    const image = sharp(input, { limitInputPixels: 40_000_000, animated: false, failOn: 'warning' });
    const meta = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(meta.format || '') || (meta.pages || 1) > 1) throw Error('Unsupported image');
    return await image.rotate().resize(1280, 720, { fit: 'contain', background: '#101a29' }).webp({ quality: 82 }).toBuffer();
  } catch { throw Error('画像を読み込めません。4000万画素以下のPNG・JPEG・WebPの静止画像を選択してください。'); }
}

/** Separate metadata and a serialized commit queue prevent late captures from reviving deleted images. */
export class Previews {
  private records = new Map<string, RecordData>();
  private writes: Promise<unknown> = Promise.resolve();
  private captures: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private directory: string;
  constructor(private manager: Manager, private capture: Capture = (id, url) => this.dockerCapture(id, url)) {
    this.directory = path.join(manager.config.root, 'previews');
  }
  private check(id: string) {
    if (!validId(id) || !Object.hasOwn(this.manager.state.apps, id)) throw Error('アプリが見つかりません。');
    return this.manager.state.apps[id];
  }
  private file(id: string, suffix = 'json') { return path.join(this.directory, `${id}.${suffix}`); }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.writes.then(fn); this.writes = next.catch(() => {}); return next;
  }
  private async save(id: string, record: RecordData) {
    const temp = this.file(id, 'json.tmp');
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    await rename(temp, this.file(id)); this.records.set(id, record);
  }
  async init() {
    await mkdir(this.directory, { recursive: true });
    for (const id of Object.keys(this.manager.state.apps)) {
      this.check(id);
      try {
        const r: RecordData = JSON.parse(await readFile(this.file(id), 'utf8'));
        if (!['auto', 'manual'].includes(r.mode) || !['missing', 'queued', 'capturing', 'ready', 'failed'].includes(r.state) || typeof r.revision !== 'string' || (r.version && !/^[a-f0-9-]{36}$/.test(r.version))) throw Error('Invalid preview metadata');
        if (r.version) await readFile(this.file(id, r.version + '.webp'));
        if (['queued', 'capturing'].includes(r.state)) { r.state = 'failed'; r.error = '再起動のため撮影を中断しました。再撮影してください。'; }
        this.records.set(id, r);
      } catch (e: any) {
        if (e.code !== 'ENOENT') this.records.set(id, { mode: 'auto', state: 'failed', revision: randomUUID(), error: '保存画像を読み込めません。再撮影してください。' });
      }
    }
    // Only registered metadata and its current image survive crash/purge recovery.
    const keep = new Set<string>();
    for (const [id, r] of this.records) { keep.add(`${id}.json`); if (r.version) keep.add(`${id}.${r.version}.webp`); }
    for (const name of await readdir(this.directory)) if (!keep.has(name) && /^[a-z][a-z0-9-]*\.(json(?:\.tmp)?|[a-f0-9-]{36}\.webp(?:\.tmp)?)$/.test(name)) await rm(path.join(this.directory, name), { force: true });
  }
  async seed() {
    for (const id of Object.keys(this.manager.state.apps)) {
      if (this.stopped) break;
      if (!this.records.has(id)) await this.request(id).catch(() => {});
    }
  }
  info(id: string) {
    const r = this.records.get(id);
    return { mode: r?.mode || 'auto', state: r?.state || 'missing', updatedAt: r?.updatedAt, error: r?.error,
      url: r?.version ? `/api/apps/${id}/preview/image?v=${r.version}` : null };
  }
  async image(id: string) {
    this.check(id); const r = this.records.get(id);
    if (!r?.version) return undefined;
    return readFile(this.file(id, r.version + '.webp'));
  }
  async request(id: string, reset = false, deployed = false) {
    const status = await this.manager.status(id);
    if (status.status !== 'running') throw Error('撮影するにはアプリを起動してください。');
    return this.serial(async () => {
      this.check(id);
      if (this.stopped) throw Error('撮影処理を終了しています。');
      const old = this.records.get(id);
      if (old?.mode === 'manual' && !reset) return this.info(id);
      if (!deployed && old && ['queued', 'capturing'].includes(old.state)) return this.info(id);
      const r: RecordData = { ...old, mode: 'auto', state: 'queued', revision: randomUUID(), error: undefined };
      await this.save(id, r);
      const next = this.captures.then(() => this.take(id, r.revision));
      this.captures = next.catch(error => console.error('Preview capture failed:', error.message));
      return this.info(id);
    });
  }
  private async take(id: string, revision: string) {
    let url = '';
    const start = await this.serial(async () => {
      const r = this.records.get(id);
      if (this.stopped || !r || r.revision !== revision) return false;
      const a = this.check(id); url = a.url;
      if (a.deletedAt || a.desired !== 'running') { await this.save(id, { ...r, state: 'failed', error: 'アプリが停止しています。' }); return false; }
      await this.save(id, { ...r, state: 'capturing' }); return true;
    });
    if (!start) return;
    try {
      const data = await normalizePreview(await this.capture(id, url));
      await this.serial(async () => {
        const r = this.records.get(id);
        if (!this.stopped && r?.revision === revision) {
          if (this.check(id).deletedAt) await this.save(id, { ...r, state: 'failed', error: 'アプリが削除されたため撮影を中断しました。' });
          else await this.commit(id, r, data);
        }
      });
    } catch {
      await this.serial(async () => {
        const r = this.records.get(id);
        if (r?.revision === revision) await this.save(id, { ...r, state: 'failed', error: '撮影できませんでした。アプリの状態を確認し、再撮影するか画像を登録してください。' });
      });
    }
  }
  private async commit(id: string, record: RecordData, data: Buffer) {
    const version = randomUUID(), file = this.file(id, version + '.webp');
    await writeFile(file + '.tmp', data, { mode: 0o600 }); await rename(file + '.tmp', file);
    try { await this.save(id, { ...record, state: 'ready', version, updatedAt: new Date().toISOString(), error: undefined }); }
    catch (e) { await rm(file, { force: true }); throw e; }
    if (record.version) await rm(this.file(id, record.version + '.webp'), { force: true });
  }
  async upload(id: string, input: Buffer) {
    this.check(id);
    // Queue validation too: delete/recreate and simultaneous uploads retain request order.
    return this.serial(async () => {
      this.check(id); const data = await normalizePreview(input);
      await this.commit(id, { ...this.records.get(id), mode: 'manual', state: 'ready', revision: randomUUID() }, data);
      return this.info(id);
    });
  }
  async remove(id: string) {
    if (!validId(id)) throw Error('Invalid app ID');
    await this.serial(async () => {
      this.records.delete(id);
      await rm(this.file(id), { force: true });
      for (const name of await readdir(this.directory)) if (name.startsWith(id + '.') && /^[a-f0-9-]{36}\.webp(?:\.tmp)?$/.test(name.slice(id.length + 1))) await rm(path.join(this.directory, name), { force: true });
    });
  }
  private async dockerCapture(id: string, url: string) {
    const name = `local-sites-preview-${randomUUID()}`;
    try {
      const result = await this.manager.docker.run(['run', '--rm', '--pull=never', '--name', name,
        '--network', `container:local-sites-${id}`, '--read-only', '--user', '1000:1000', '--init',
        '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '512m', '--cpus', '1',
        '--pids-limit', '128', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m', '--shm-size', '128m',
        'local-sites-preview:1', url], 30000, 3 * 1024 * 1024);
      if (!/^[A-Za-z0-9+/]+=*$/.test(result)) throw Error('Invalid capture output');
      return Buffer.from(result, 'base64');
    } finally {
      // Killing the docker client does not stop a running container.
      await this.manager.docker.run(['rm', '-f', name], 5000).catch(() => {});
    }
  }
  async idle() { await this.captures; await this.writes; }
  async stop() { this.stopped = true; await this.idle(); }
}
