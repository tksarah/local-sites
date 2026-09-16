import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const [command, source, output] = process.argv.slice(2);
if (command === 'package') {
  const root = path.resolve(source), spec = JSON.parse(await readFile(path.join(root, 'local-sites.json'), 'utf8'));
  if (!Array.isArray(spec.files) || !spec.files.length) throw new Error('An explicit files allowlist is required');
  const files = [...new Set(['Dockerfile', 'local-sites.json', ...spec.files])];
  async function check(name) {
    if (typeof name !== 'string' || !name || name.includes('\\') || name.startsWith('/') || name.includes(':') || name.split('/').some(p => p === '..' || ['.git', '.ssh', 'node_modules', '.env'].includes(p) || p.startsWith('.env.') || /\.(pem|key)$/i.test(p))) throw new Error('Unsafe or excluded path');
    const stat = await lstat(path.join(root, name));
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw new Error('Links and special files are not allowed');
    if (stat.isDirectory()) for (const child of await readdir(path.join(root, name))) await check(`${name}/${child}`);
  }
  for (const file of files) await check(file);
  const result = spawnSync('tar', ['-czf', path.resolve(output), '-C', root, '--', ...files], { encoding: 'utf8', shell: false });
  if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr);
  console.log(`Packaged ${path.resolve(output)}`);
} else if (command === 'upload') {
  const base = process.env.LOCAL_SITES_URL || JSON.parse(await readFile(new URL('../connection.json', import.meta.url),'utf8')).serverUrl;
  if (!base.startsWith('https://')) throw new Error('HTTPS is required');
  const token = process.env.LOCAL_SITES_TOKEN || (process.env.LOCAL_SITES_TOKEN_FILE ? (await readFile(process.env.LOCAL_SITES_TOKEN_FILE, 'utf8')).trim() : '');
  if (!token) throw new Error('Set LOCAL_SITES_TOKEN or LOCAL_SITES_TOKEN_FILE');
  const bytes = await readFile(source); if (bytes.length > 25 * 1024 * 1024) throw new Error('Archive exceeds 25 MiB');
  const response = await fetch(`${base}/uploads`, { method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/gzip' }, body: bytes, signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`Upload failed: ${response.status}`);
  console.log(await response.text());
} else throw new Error('Usage: client.mjs package source-directory output.tgz | upload archive.tgz');
