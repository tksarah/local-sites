import { createHash, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export async function authenticate(file: string, header?: string): Promise<string | undefined> {
  if (!header?.startsWith('Bearer ')) return;
  const hash = Buffer.from(digest(header.slice(7)), 'hex');
  const entries: { name: string; sha256: string; pending?: boolean; expiresAt?: number }[] = JSON.parse(await readFile(file, 'utf8'));
  return entries.find(e => !e.pending && (!e.expiresAt || e.expiresAt > Date.now()) && /^[a-f0-9]{64}$/.test(e.sha256) && timingSafeEqual(hash, Buffer.from(e.sha256, 'hex')))?.name;
}
export function safeArchiveEntry(name: string, type: string, size: number) {
  const parts = name.replaceAll('\\', '/').split('/');
  if (!name || name.startsWith('/') || name.includes('\\') || parts.includes('..') || /^[A-Za-z]:/.test(name)) throw new Error('Unsafe archive path');
  if (!['File', 'Directory'].includes(type)) throw new Error('Archive links and special files are forbidden');
  if (size > 100 * 1024 * 1024) throw new Error('Archive entry too large');
  if (parts.some(p => ['.git', 'node_modules', '.ssh'].includes(p) || p === '.env' || p.startsWith('.env.') || /\.(pem|key)$/i.test(p))) throw new Error('Archive contains excluded or secret files');
}
