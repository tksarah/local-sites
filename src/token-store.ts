import { mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export type Credential = { name: string; sha256: string; pending?: boolean; expiresAt?: number; createdAt?: number };
export async function tokenTransaction<T>(file: string, fn: (entries: Credential[]) => Promise<T> | T): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = file + '.lock';
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await mkdir(lock, { mode: 0o700 }); acquired = true; break; }
    catch (e: any) { if (e.code !== 'EEXIST') throw e; await new Promise(r => setTimeout(r, 50)); }
  }
  if (!acquired) throw new Error('認証情報は更新中です。時間をおいて再実行してください。');
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    let entries: Credential[] = [];
    try { entries = JSON.parse(await readFile(file, 'utf8')); } catch (e: any) { if (e.code !== 'ENOENT') throw e; }
    const result = await fn(entries);
    await writeFile(temp, JSON.stringify(entries, null, 2), { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
    return result;
  } finally { await rm(temp, { force: true }); await rm(lock, { recursive: true, force: true }); }
}
