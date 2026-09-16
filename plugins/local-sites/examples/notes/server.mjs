import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
const directory = process.env.DATA_DIR || './data'; mkdirSync(directory, { recursive: true });
const db = new DatabaseSync(`${directory}/notes.sqlite`);
db.exec('CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
const page = `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>local-sites メモ</title><style>body{font:18px system-ui;max-width:680px;margin:60px auto;padding:24px;background:#f3f7fa;color:#183040}textarea{box-sizing:border-box;width:100%;padding:16px;font:inherit}button{padding:12px 24px;margin:12px 0;background:#146b73;color:white;border:0;border-radius:8px}li{background:white;padding:16px;margin:8px 0;border-radius:8px;white-space:pre-wrap}small{color:#526875}</style><h1>local-sites メモ</h1><p>Ubuntu 上で動く、保存できる小さなアプリです。</p><form><textarea required maxlength="2000" placeholder="メモを入力"></textarea><button>保存</button></form><small id="status"></small><ul></ul><script>async function load(){const r=await fetch('/api/notes');const items=await r.json();document.querySelector('ul').replaceChildren(...items.map(n=>{const li=document.createElement('li');li.textContent=n.body;return li}));}document.querySelector('form').onsubmit=async e=>{e.preventDefault();const input=document.querySelector('textarea');const r=await fetch('/api/notes',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({body:input.value})});document.querySelector('#status').textContent=r.ok?'保存しました':'保存できませんでした';if(r.ok){input.value='';await load();}};load();</script></html>`;
http.createServer(async (req, res) => {
  const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  if (req.url === '/healthz') return json(200, { ok: true });
  if (req.url === '/api/notes' && req.method === 'GET') return json(200, db.prepare('SELECT * FROM notes ORDER BY id DESC LIMIT 100').all());
  if (req.url === '/api/notes' && req.method === 'POST') {
    if (req.headers.origin && req.headers.origin !== `${req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http'}://${req.headers.host}`) return json(403, { error: 'origin' });
    let body = '';
    try { for await (const chunk of req) { body += chunk; if (body.length > 10000) return json(413, { error: 'size' }); }
      const value = JSON.parse(body).body;
      if (typeof value !== 'string' || !value.trim() || value.length > 2000) return json(400, { error: 'body' });
      db.prepare('INSERT INTO notes(body) VALUES(?)').run(value); return json(201, { ok: true });
    } catch { return json(400, { error: 'invalid request' }); }
  }
  if (req.url !== '/' || req.method !== 'GET') return json(404, { error: 'not found' });
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(page);
}).listen(Number(process.env.PORT || 3000), '0.0.0.0');
