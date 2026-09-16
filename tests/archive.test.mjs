import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { extractArchive } from '../dist/archive.js';
function archive(name, type = '0', body = 'hello') {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100); header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
  header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.write('00000000000\0', 136);
  header.fill(32, 148, 156); header.write(type, 156); header.write('ustar\0', 257); header.write('00', 263);
  const sum = header.reduce((a, b) => a + b, 0); header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  const data = Buffer.alloc(Math.ceil(body.length / 512) * 512); data.write(body);
  return gzipSync(Buffer.concat([header, data, Buffer.alloc(1024)]));
}
test('actual compressed archives reject traversal and links without crashing the service', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'local-sites-archive-')); t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, type] of [['../escape', '0'], ['.env', '0'], ['link', '2']]) {
    const file = path.join(root, 'input.tgz'); await writeFile(file, archive(name, type));
    await assert.rejects(() => extractArchive(file, path.join(root, 'out')));
  }
  const file = path.join(root, 'valid.tgz'); await writeFile(file, archive('index.html'));
  await extractArchive(file, path.join(root, 'out'));
  assert.equal(await readFile(path.join(root, 'out/index.html'), 'utf8'), 'hello');
});
