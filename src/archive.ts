import * as tar from 'tar';
import { mkdir } from 'node:fs/promises';
import { safeArchiveEntry } from './security.js';
export async function extractArchive(file: string, destination: string) {
  let count = 0, bytes = 0, invalid: Error | undefined;
  // Validate the whole archive before extraction; link entries are never allowed.
  await tar.t({ file, strict: true, onReadEntry: entry => {
    try { safeArchiveEntry(entry.path, entry.type, entry.size); } catch (error) { invalid = error as Error; }
    count++; bytes += entry.size;
    if (count > 10000 || bytes > 250 * 1024 * 1024) invalid = new Error('Expanded archive limit exceeded');
  }});
  if (invalid) throw invalid;
  if (!count) throw new Error('Empty archive');
  await mkdir(destination, { recursive: true });
  await tar.x({ file, cwd: destination, strict: true, preservePaths: false, noChmod: true,
    filter: (name, entry) => { if (!('type' in entry)) throw new Error('Invalid archive entry'); safeArchiveEntry(name, entry.type, entry.size); return true; } });
}
