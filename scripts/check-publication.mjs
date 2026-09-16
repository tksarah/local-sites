import { execFileSync } from 'node:child_process';
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
if (!files.length) throw Error('No tracked files to audit');
const forbidden = /(?:^|\/)(?:\.local-sites|node_modules|dist|setup-public|\.env|tokens\.json|known_hosts|id_rsa|id_ed25519)(?:\/|$)|\.(?:token|pem|key|crt|tgz|zip|log|png)$/i;
const rules = [
  ['private-key', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/],
  ['provider-token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-proj-[A-Za-z0-9_-]{30,}|AKIA[A-Z0-9]{16})\b/],
  ['personal-path', /(?:[A-Z]:[\\/]+Users[\\/]+[^\s\\/]+|\/home\/[a-z][a-z0-9_-]*\/)/i],
  ['credential-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
];
let failures = 0;
for (const file of files) {
  if (forbidden.test(file)) { console.error(`${file}: excluded file type`); failures++; }
  const text = execFileSync('git', ['show', ':' + file], {encoding: 'utf8'});
  for (const [label, pattern] of rules) if (pattern.test(text)) { console.error(`${file}: ${label}`); failures++; }
}
if (failures) process.exitCode = 1;
else console.log(`Publication audit passed: ${files.length} tracked files; no matched secrets or personal paths.`);
