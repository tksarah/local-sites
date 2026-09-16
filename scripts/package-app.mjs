import path from 'node:path';
import { readFile, lstat } from 'node:fs/promises';
import * as tar from 'tar';
const [source, output] = process.argv.slice(2);
if (!source || !output) throw new Error('Usage: node scripts/package-app.mjs source-directory output.tgz');
const root = path.resolve(source), spec = JSON.parse(await readFile(path.join(root, 'local-sites.json'), 'utf8'));
if (!Array.isArray(spec.files) || !spec.files.length) throw new Error('local-sites.json requires an explicit files allowlist');
const files = [...new Set(['Dockerfile', 'local-sites.json', ...spec.files])];
for (const file of files) {
  if (typeof file !== 'string' || !file || file.includes('\\') || file.startsWith('/') || file.split('/').includes('..') || file.includes(':')) throw new Error('Unsafe allowlist path');
  await lstat(path.join(root, file));
}
await tar.c({ gzip: true, file: path.resolve(output), cwd: root, portable: true, filter: (name, stat) => {
  const parts = name.split('/');
  if (stat.isSymbolicLink()) throw new Error('Symlinks are forbidden');
  if (parts.some(p => ['node_modules', '.git', '.ssh', '.env'].includes(p) || p.startsWith('.env.') || /\.(pem|key)$/i.test(p))) throw new Error(`Excluded file in allowlist: ${name}`);
  return true;
}}, files);
console.log(`Packaged ${path.resolve(output)}`);
